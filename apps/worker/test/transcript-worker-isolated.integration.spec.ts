import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../../api/src/config/environment.js";
import { PrismaService } from "../../api/src/database/prisma.service.js";
import { seedFrameContext } from "../../api/test/fixtures/frame-evidence-fixture.js";
import { PgTranscriptWorker } from "../src/infrastructure/pg-transcript-worker.js";

describe.runIf(process.env.TRANSCRIPT_WORKER_ISOLATED_TESTS === "1")(
  "transcript worker isolated PostgreSQL and object storage",
  () => {
    const name = `content_factory_transcript_${randomUUID().replaceAll("-", "")}`;
    const previousDatabase = process.env.POSTGRES_DB;
    const objectKeys = new Set<string>();
    let admin: Pool;
    let isolated: Pool;
    let isolatedUrl: string;
    let prisma: PrismaService;
    let storage: S3Client;
    let created = false;

    beforeAll(async () => {
      if (!/^content_factory_transcript_[a-f0-9]{32}$/.test(name))
        throw new Error("ISOLATION_GUARD_FAILED");
      const base = new URL(databaseUrl());
      base.pathname = "/postgres";
      admin = new Pool({ connectionString: base.toString(), max: 1 });
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      base.pathname = `/${name}`;
      isolatedUrl = base.toString();
      isolated = new Pool({ connectionString: isolatedUrl, max: 2 });
      const migrations = resolve(
        import.meta.dirname,
        "../../api/prisma/migrations",
      );
      for (const entry of (await readdir(migrations, { withFileTypes: true }))
        .filter((value) => value.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))) {
        await isolated.query(
          await readFile(join(migrations, entry.name, "migration.sql"), "utf8"),
        );
      }
      process.env.POSTGRES_DB = name;
      prisma = new PrismaService();
      await prisma.onModuleInit();
      storage = new S3Client({
        endpoint: requiredEnvironment("S3_ENDPOINT"),
        region: requiredEnvironment("S3_REGION"),
        forcePathStyle: true,
        credentials: {
          accessKeyId: requiredEnvironment("S3_ACCESS_KEY"),
          secretAccessKey: requiredEnvironment("S3_SECRET_KEY"),
        },
      });
    }, 60_000);

    afterAll(async () => {
      for (const key of objectKeys) {
        await storage
          ?.send(
            new DeleteObjectCommand({
              Bucket: requiredEnvironment("S3_SOURCE_BUCKET"),
              Key: key,
            }),
          )
          .catch(() => undefined);
      }
      storage?.destroy();
      await prisma?.onModuleDestroy();
      await isolated?.end();
      restore("POSTGRES_DB", previousDatabase);
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin?.end();
    });

    it("creates one authoritative READY artifact and ignores duplicate delivery after restart", async () => {
      const intentId = await createIntent();
      const firstWorker = createWorker();
      await firstWorker.process(intentId);
      await firstWorker.close();
      const restartedWorker = createWorker();
      await restartedWorker.process(intentId);
      await restartedWorker.close();

      const intent = await prisma.transcriptEvidenceIntent.findUniqueOrThrow({
        where: { id: intentId },
        include: { attempts: true, artifact: true },
      });
      const objectKey = intent.artifact!.objectKey;
      objectKeys.add(objectKey);
      expect(intent).toMatchObject({
        state: "READY",
        attemptCount: 1,
        attempts: [{ attemptNumber: 1, state: "READY" }],
        artifact: {
          objectKey,
          contentType: "application/json",
          adapterVersion: "local-manual-transcript-v1",
        },
      });
      expect(objectKey).toMatch(
        new RegExp(
          `^ai-content/transcripts/${intentId}/attempts/.+/transcript\\.json$`,
        ),
      );
      expect(intent.artifact).not.toBeNull();
      const bytes = await readStoredObject(objectKey);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        intent.artifact!.sha256,
      );
      expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({
        contractVersion: "editorial-transcript-v1",
        language: "ru",
        segments: [{ ordinal: 0, startMs: 0, endMs: 1_000 }],
      });
    });

    it("records an expired lease and completes exactly one retry after worker restart", async () => {
      const intentId = await createIntent();
      await prisma.$transaction([
        prisma.transcriptEvidenceAttempt.create({
          data: {
            id: randomUUID(),
            intentId,
            attemptNumber: 1,
            workerId: "terminated-worker",
            leaseToken: randomUUID(),
            leaseExpiresAt: new Date(Date.now() - 60_000),
            workDeadlineAt: new Date(Date.now() - 30_000),
            updatedAt: new Date(),
          },
        }),
        prisma.transcriptEvidenceIntent.update({
          where: { id: intentId },
          data: { state: "PROCESSING", attemptCount: 1, startedAt: new Date() },
        }),
      ]);

      const restartedWorker = createWorker();
      await restartedWorker.process(intentId);
      await restartedWorker.close();
      const duplicateWorker = createWorker();
      await duplicateWorker.process(intentId);
      await duplicateWorker.close();

      const intent = await prisma.transcriptEvidenceIntent.findUniqueOrThrow({
        where: { id: intentId },
        include: {
          attempts: { orderBy: { attemptNumber: "asc" } },
          artifact: true,
        },
      });
      const objectKey = intent.artifact!.objectKey;
      objectKeys.add(objectKey);
      expect(intent).toMatchObject({
        state: "READY",
        attemptCount: 2,
        attempts: [
          {
            attemptNumber: 1,
            state: "FAILED_FINAL",
            failureCode: "TRANSCRIPT_LEASE_EXPIRED",
          },
          { attemptNumber: 2, state: "READY" },
        ],
        artifact: { objectKey },
      });
      expect(
        await prisma.transcriptEvidenceArtifact.count({
          where: { intentId },
        }),
      ).toBe(1);
      expect(await readStoredObject(objectKey)).not.toHaveLength(0);
    });

    it("removes its attempt-scoped upload when immutable source context becomes stale", async () => {
      const intentId = await createIntent();
      const intentBefore =
        await prisma.transcriptEvidenceIntent.findUniqueOrThrow({
          where: { id: intentId },
          select: { sourceId: true, sourceVersion: true },
        });
      await prisma.sourceAuthorization.update({
        where: {
          sourceId_sourceVersion: {
            sourceId: intentBefore.sourceId,
            sourceVersion: intentBefore.sourceVersion,
          },
        },
        data: {
          status: "NOT_REVIEWED",
          basis: null,
          declarationVersion: null,
          decidedAt: null,
        },
      });

      const worker = createWorker();
      await worker.process(intentId);
      await worker.close();

      const intent = await prisma.transcriptEvidenceIntent.findUniqueOrThrow({
        where: { id: intentId },
        include: { attempts: true, artifact: true },
      });
      expect(intent).toMatchObject({
        state: "FAILED_FINAL",
        failureCode: "TRANSCRIPT_CONTEXT_STALE",
        attempts: [
          {
            state: "FAILED_FINAL",
            failureCode: "TRANSCRIPT_CONTEXT_STALE",
          },
        ],
        artifact: null,
      });
      const attemptKey = `ai-content/transcripts/${intentId}/attempts/${intent.attempts[0]!.id}/transcript.json`;
      objectKeys.add(attemptKey);
      await expect(readStoredObject(attemptKey)).rejects.toMatchObject({
        name: "NoSuchKey",
      });
    });

    it("persists bounded delivery failure and exhausts the retry without getting stuck", async () => {
      const intentId = await createIntent();
      const unavailableBucket = `missing-transcript-${randomUUID()}`;
      const firstWorker = createWorker(unavailableBucket);
      try {
        await expect(firstWorker.process(intentId)).rejects.toMatchObject({
          name: "AccessDenied",
        });
      } finally {
        await firstWorker.close();
      }
      await expect(
        prisma.transcriptEvidenceIntent.findUniqueOrThrow({
          where: { id: intentId },
          include: { attempts: true, artifact: true },
        }),
      ).resolves.toMatchObject({
        state: "QUEUED",
        attemptCount: 1,
        attempts: [
          {
            attemptNumber: 1,
            state: "FAILED_FINAL",
            failureCode: "TRANSCRIPT_DELIVERY_FAILED",
          },
        ],
        artifact: null,
      });

      const retryWorker = createWorker(unavailableBucket);
      try {
        await expect(retryWorker.process(intentId)).rejects.toMatchObject({
          name: "AccessDenied",
        });
      } finally {
        await retryWorker.close();
      }
      const terminal = await prisma.transcriptEvidenceIntent.findUniqueOrThrow({
        where: { id: intentId },
        include: { attempts: { orderBy: { attemptNumber: "asc" } } },
      });
      expect(terminal).toMatchObject({
        state: "FAILED_FINAL",
        attemptCount: 2,
        failureCode: "TRANSCRIPT_DELIVERY_FAILED",
        attempts: [
          { attemptNumber: 1, state: "FAILED_FINAL" },
          {
            attemptNumber: 2,
            state: "FAILED_FINAL",
            failureCode: "TRANSCRIPT_DELIVERY_FAILED",
          },
        ],
      });
      expect(
        await prisma.transcriptEvidenceArtifact.count({
          where: { intentId },
        }),
      ).toBe(0);
    });

    async function createIntent(): Promise<string> {
      const fixture = await seedFrameContext(prisma);
      const intentId = randomUUID();
      await prisma.transcriptEvidenceIntent.create({
        data: {
          id: intentId,
          idempotencyKey: randomUUID(),
          requestFingerprint: `transcript-worker-smoke:${intentId}`,
          projectId: fixture.projectId,
          sourceId: fixture.sourceId,
          sourceVersion: 1,
          sourceSha256: "a".repeat(64),
          sourceAuthorizationRevision: 1,
          sourceAuthorizationBasis: "OPERATOR_ATTESTATION",
          sourceAuthorizationDeclarationVersion: "source-rights-v1",
          sourceAuthorizationDecidedAt: new Date("2026-09-16T00:00:00.000Z"),
          cutPipelineJobId: fixture.cutJobId,
          cutResultArtifactId: fixture.artifactId,
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: 512n,
          cutStartMs: 1_000,
          cutEndMs: 4_000,
          creatorProfileRevisionId: fixture.profileRevisionId,
          creatorProfileId: fixture.profileId,
          creatorProfileRevisionNo: 1,
          sourceContextRevisionId: fixture.contextRevisionId,
          sourceContextId: fixture.contextId,
          sourceContextRevisionNo: 1,
          cutPromptRevisionId: fixture.promptRevisionId,
          cutPromptId: fixture.promptId,
          cutPromptRevisionNo: 1,
          contractVersion: "editorial-transcript-v1",
          adapterVersion: "local-manual-transcript-v1",
          language: "ru",
          fixture: {
            language: "ru",
            segments: [
              {
                ordinal: 0,
                startMs: 0,
                endMs: 1_000,
                text: "Проверенный локальный transcript fixture.",
              },
            ],
          },
        },
      });
      return intentId;
    }

    function createWorker(
      bucket = requiredEnvironment("S3_SOURCE_BUCKET"),
    ): PgTranscriptWorker {
      return new PgTranscriptWorker({
        databaseUrl: isolatedUrl,
        bucket,
        storage: {
          endpoint: requiredEnvironment("S3_ENDPOINT"),
          region: requiredEnvironment("S3_REGION"),
          accessKey: requiredEnvironment("S3_ACCESS_KEY"),
          secretKey: requiredEnvironment("S3_SECRET_KEY"),
        },
      });
    }

    async function readStoredObject(key: string): Promise<Buffer> {
      const response = await storage.send(
        new GetObjectCommand({
          Bucket: requiredEnvironment("S3_SOURCE_BUCKET"),
          Key: key,
        }),
      );
      if (!response.Body) throw new Error("TRANSCRIPT_OBJECT_BODY_MISSING");
      return Buffer.from(await response.Body.transformToByteArray());
    }
  },
);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_${name}_REQUIRED`);
  return value;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
