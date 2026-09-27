import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  PublicationIdempotencyConflictError,
  PublicationOutcomeResolutionConflictError,
} from "../src/publishing/domain/publication.js";
import { PrismaPublicationRepository } from "../src/publishing/infrastructure/prisma-publication.repository.js";
import { seedFrameContext } from "./fixtures/frame-evidence-fixture.js";

describe.runIf(process.env.PUBLICATION_ISOLATED_TESTS === "1")(
  "publication repository isolated PostgreSQL",
  () => {
    const databaseName = `cf_publication_test_${randomUUID().replaceAll("-", "")}`;
    const previousDatabase = process.env.POSTGRES_DB;
    let admin: Pool;
    let isolated: Pool;
    let prisma: PrismaService;
    let repository: PrismaPublicationRepository;
    let created = false;

    beforeAll(async () => {
      const base = new URL(databaseUrl());
      if (
        !/^cf_publication_test_[a-f0-9]{32}$/.test(databaseName) ||
        base.pathname.slice(1) === databaseName
      )
        throw new Error("ISOLATION_GUARD_FAILED");
      base.pathname = "/postgres";
      admin = new Pool({ connectionString: base.toString(), max: 1 });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      base.pathname = `/${databaseName}`;
      isolated = new Pool({ connectionString: base.toString(), max: 2 });
      const connected = await isolated.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      if (connected.rows[0]?.name !== databaseName)
        throw new Error("ISOLATION_GUARD_FAILED");
      const migrations = join(import.meta.dirname, "../prisma/migrations");
      for (const entry of (await readdir(migrations, { withFileTypes: true }))
        .filter((value) => value.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name)))
        await isolated.query(
          await readFile(join(migrations, entry.name, "migration.sql"), "utf8"),
        );
      process.env.POSTGRES_DB = databaseName;
      prisma = new PrismaService();
      await prisma.$connect();
      repository = new PrismaPublicationRepository(prisma);
    }, 30_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await isolated?.end();
      if (
        created &&
        /^cf_publication_test_[a-f0-9]{32}$/.test(databaseName)
      )
        await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin?.end();
      if (previousDatabase === undefined) delete process.env.POSTGRES_DB;
      else process.env.POSTGRES_DB = previousDatabase;
    });

    it("persists exact replay, revoke, unknown-outcome resolution, and retry fences", async () => {
      const fixture = await seedFrameContext(prisma);
      const vertical = await seedApprovedVertical(fixture);
      const localChannel = await repository.createChannel({
        id: randomUUID(),
        projectId: fixture.projectId,
        platform: "LOCAL_DRY_RUN",
        displayName: "Local acceptance",
        externalChannelRef: "local",
        timezone: "UTC",
      });
      const createInput = {
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        requestFingerprint: "d".repeat(64),
        projectId: fixture.projectId,
        channelId: localChannel.id,
        contentKind: "VERTICAL_RESULT" as const,
        verticalApprovalId: vertical.approvalId,
        verticalResultId: vertical.resultId,
        platform: "LOCAL_DRY_RUN" as const,
        scheduledAt: new Date("2026-09-29T10:00:00.000Z"),
        timezone: "UTC",
        metadataSnapshot: { title: "Exact publication" },
      };
      const createdIntent = await repository.create(createInput);
      await expect(repository.create(createInput)).resolves.toEqual(createdIntent);
      await expect(
        repository.create({
          ...createInput,
          id: randomUUID(),
          requestFingerprint: "e".repeat(64),
        }),
      ).rejects.toBeInstanceOf(PublicationIdempotencyConflictError);

      const revoked = await repository.revokeChannel(
        fixture.projectId,
        localChannel.id,
        new Date("2026-09-29T09:00:00.000Z"),
      );
      expect(revoked?.state).toBe("REVOKED");
      await expect(repository.get(createdIntent.id)).resolves.toMatchObject({
        state: "CANCELED",
      });

      const youtubeChannel = await repository.createChannel({
        id: randomUUID(),
        projectId: fixture.projectId,
        platform: "YOUTUBE",
        displayName: "YouTube acceptance",
        externalChannelRef: `UC${"a".repeat(22)}`,
        timezone: "UTC",
      });
      const unknownIntent = await repository.create({
        ...createInput,
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        requestFingerprint: "f".repeat(64),
        channelId: youtubeChannel.id,
        platform: "YOUTUBE",
      });
      await prisma.publicationIntent.update({
        where: { id: unknownIntent.id },
        data: {
          state: "UNKNOWN_REMOTE_STATE",
          failureCode: "PUBLICATION_ATTEMPT_TIMEOUT",
          failureMessage: "Provider outcome is unknown.",
          remoteStatus: "attempt_timeout",
          attemptCount: 1,
        },
      });
      await prisma.publicationProviderSession.create({
        data: {
          publicationIntentId: unknownIntent.id,
          platform: "YOUTUBE",
          ciphertext: Buffer.from("ciphertext"),
          iv: Buffer.alloc(12, 1),
          authTag: Buffer.alloc(16, 2),
          keyVersion: "v1",
        },
      });
      const resolved = await repository.confirmRemoteAbsent(
        unknownIntent.id,
        new Date("2026-09-29T09:05:00.000Z"),
      );
      expect(resolved).toMatchObject({
        state: "FAILED_FINAL",
        failure: { code: "PUBLICATION_REMOTE_ABSENCE_CONFIRMED" },
        remoteStatus: "operator_confirmed_absent",
      });
      await expect(
        prisma.publicationProviderSession.findUnique({
          where: { publicationIntentId: unknownIntent.id },
        }),
      ).resolves.toBeNull();
      await expect(
        repository.confirmRemoteAbsent(
          unknownIntent.id,
          new Date("2026-09-29T09:06:00.000Z"),
        ),
      ).rejects.toBeInstanceOf(PublicationOutcomeResolutionConflictError);
      await expect(
        repository.retry(
          unknownIntent.id,
          new Date("2026-09-29T09:07:00.000Z"),
        ),
      ).resolves.toMatchObject({
        state: "QUEUED",
        attemptCount: 0,
        failure: null,
        remoteStatus: null,
      });
      await prisma.publicationIntent.update({
        where: { id: unknownIntent.id },
        data: {
          state: "UNKNOWN_REMOTE_STATE",
          attemptCount: 1,
          remotePublicationId: "remote-video-42",
          remoteStatus: "processing",
          failureCode: "PUBLICATION_FINALIZE_OUTCOME_UNKNOWN",
          failureMessage: "Provider returned a durable remote identifier.",
        },
      });
      await expect(
        repository.confirmRemoteAbsent(
          unknownIntent.id,
          new Date("2026-09-29T09:08:00.000Z"),
        ),
      ).rejects.toBeInstanceOf(PublicationOutcomeResolutionConflictError);
      await expect(repository.get(unknownIntent.id)).resolves.toMatchObject({
        state: "UNKNOWN_REMOTE_STATE",
        remotePublicationId: "remote-video-42",
      });
    });

    async function seedApprovedVertical(fixture: {
      projectId: string;
      sourceId: string;
      cutJobId: string;
      artifactId: string;
    }) {
      const intentId = randomUUID();
      const jobId = randomUUID();
      const artifactId = randomUUID();
      const resultId = randomUUID();
      const approvalId = randomUUID();
      await prisma.verticalRenderIntent.create({
        data: {
          id: intentId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "vertical-request-v1",
          projectId: fixture.projectId,
          sourceId: fixture.sourceId,
          sourceVersion: 1,
          cutPipelineJobId: fixture.cutJobId,
          cutResultArtifactId: fixture.artifactId,
          renderContractVersion: "vertical-render-v1",
        },
      });
      await prisma.pipelineJob.create({
        data: {
          id: jobId,
          projectId: fixture.projectId,
          sourceId: fixture.sourceId,
          sourceVersion: 1,
          type: "RENDER_VERTICAL",
          state: "READY",
          idempotencyKey: randomUUID(),
          recipeVersion: "vertical-render-v1",
          verticalRenderIntentId: intentId,
        },
      });
      await prisma.mediaArtifact.create({
        data: {
          id: artifactId,
          projectId: fixture.projectId,
          sourceId: fixture.sourceId,
          role: "VERTICAL_RENDER_RESULT",
          status: "READY",
          objectKey: `test/vertical/${artifactId}.mp4`,
          sizeBytes: 2048n,
          sha256: "c".repeat(64),
          contentType: "video/mp4",
          lineageSourceId: fixture.sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "vertical-render-v1",
          pipelineJobId: jobId,
        },
      });
      await prisma.verticalRenderResult.create({
        data: {
          id: resultId,
          intentId,
          pipelineJobId: jobId,
          artifactId,
          renderContractVersion: "vertical-render-v1",
          durationMs: 3000,
          width: 1080,
          height: 1920,
          sha256: "c".repeat(64),
          sizeBytes: 2048n,
          completedAt: new Date("2026-09-29T08:00:00.000Z"),
        },
      });
      await prisma.verticalApproval.create({
        data: {
          id: approvalId,
          resultId,
          approvalVersion: "human-vertical-approval-v1",
        },
      });
      return { resultId, approvalId };
    }
  },
);
