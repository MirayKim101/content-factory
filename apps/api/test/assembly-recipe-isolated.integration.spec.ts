import "reflect-metadata";

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";

import {
  BadRequestException,
  Module,
  ValidationPipe,
  type INestApplication,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { databaseUrl } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { ASSEMBLY_RECIPE_REPOSITORY } from "../src/editorial-content/application/assembly-recipe-repository.port.js";
import {
  ASSEMBLY_RENDER_ADMISSION_ENABLED,
  ASSEMBLY_RENDER_REPOSITORY,
} from "../src/editorial-content/application/assembly-render-repository.port.js";
import {
  GetAssemblyRender,
  GetAssemblyRenderContent,
  ListAssemblyRenders,
} from "../src/editorial-content/application/assembly-render-queries.js";
import { CreateAssemblyRender } from "../src/editorial-content/application/create-assembly-render.js";
import {
  GetAssemblyRecipe,
  GetAssemblyRecipeRevision,
  ListAssemblyRecipes,
} from "../src/editorial-content/application/assembly-recipe-queries.js";
import { SaveAssemblyRecipe } from "../src/editorial-content/application/save-assembly-recipe.js";
import { PrismaAssemblyRecipeRepository } from "../src/editorial-content/infrastructure/prisma-assembly-recipe.repository.js";
import { PrismaAssemblyRenderRepository } from "../src/editorial-content/infrastructure/prisma-assembly-render.repository.js";
import { AssemblyRecipeController } from "../src/editorial-content/presentation/assembly-recipe.controller.js";
import { AssemblyRenderController } from "../src/editorial-content/presentation/assembly-render.controller.js";
import {
  EDITORIAL_APPROVAL_ADMISSION_ENABLED,
  EDITORIAL_APPROVAL_REPOSITORY,
  EDITORIAL_INTEGRATED_REVIEW_ENABLED,
} from "../src/editorial-content/application/editorial-approval-repository.port.js";
import { CreateEditorialApproval } from "../src/editorial-content/application/create-editorial-approval.js";
import { EditorialApprovalCandidateConflictError } from "../src/editorial-content/domain/editorial-approval.js";
import {
  GetEditorialReview,
  ListEditorialApprovals,
} from "../src/editorial-content/application/editorial-approval-queries.js";
import { PrismaEditorialApprovalRepository } from "../src/editorial-content/infrastructure/prisma-editorial-approval.repository.js";
import { EditorialApprovalController } from "../src/editorial-content/presentation/editorial-approval.controller.js";
import {
  EDITORIAL_EXPORT_ADMISSION_ENABLED,
  EDITORIAL_EXPORT_REPOSITORY,
} from "../src/editorial-content/application/editorial-export-repository.port.js";
import { CreateEditorialExport } from "../src/editorial-content/application/create-editorial-export.js";
import {
  GetEditorialExport,
  GetEditorialExportContent,
  ListEditorialExports,
} from "../src/editorial-content/application/editorial-export-queries.js";
import { PrismaEditorialExportRepository } from "../src/editorial-content/infrastructure/prisma-editorial-export.repository.js";
import { EditorialExportApprovalStaleError } from "../src/editorial-content/domain/editorial-export.js";
import { EditorialExportController } from "../src/editorial-content/presentation/editorial-export.controller.js";
import { HttpExceptionFilter } from "../src/http-exception.filter.js";
import { JOB_DISPATCH } from "../src/media-pipeline/application/job-dispatch.port.js";
import { PrismaPipelineRepository } from "../src/media-pipeline/infrastructure/prisma-pipeline.repository.js";
import { OBJECT_STORAGE } from "../src/projects/application/object-storage.port.js";

describe.runIf(process.env.ASSEMBLY_RECIPE_ISOLATED_TESTS === "1")(
  "assembly recipe isolated HTTP/PostgreSQL",
  () => {
    const name = `content_factory_recipe_test_${randomUUID().replaceAll("-", "")}`;
    const shadowName = `${name}_shadow`;
    const previous = {
      POSTGRES_DB: process.env.POSTGRES_DB,
      SOURCE_AUTHORIZATION_POLICY: process.env.SOURCE_AUTHORIZATION_POLICY,
      DEPLOYMENT_PROFILE: process.env.DEPLOYMENT_PROFILE,
      MEDIA_QUEUE_DISABLED: process.env.MEDIA_QUEUE_DISABLED,
    };
    let admin: Pool;
    let isolated: Pool;
    let prisma: PrismaService;
    let app: INestApplication;
    let created = false;
    const dispatch = { dispatch: vi.fn(async () => undefined) };
    const content = Buffer.from("assembly-result");
    const storage = {
      readObject: vi.fn(async (_objectKey: string, range?: string) => {
        if (range === "bytes=1-3") {
          return {
            body: Readable.from(content.subarray(1, 4)),
            contentLength: 3,
            contentType: "video/mp4",
            contentRange: `bytes 1-3/${content.length}`,
            etag: '"assembly-etag"',
          };
        }
        return {
          body: Readable.from(content),
          contentLength: content.length,
          contentType: "video/mp4",
        };
      }),
    };

    beforeAll(async () => {
      const base = new URL(databaseUrl());
      if (
        !/^content_factory_recipe_test_[a-f0-9]{32}$/.test(name) ||
        base.pathname.slice(1) === name
      ) {
        throw new Error("ISOLATION_GUARD_FAILED");
      }
      base.pathname = "/postgres";
      admin = new Pool({ connectionString: base.toString(), max: 1 });
      await admin.query(`CREATE DATABASE "${name}"`);
      await admin.query(`CREATE DATABASE "${shadowName}"`);
      created = true;
      base.pathname = `/${name}`;
      const isolatedUrl = base.toString();
      base.pathname = `/${shadowName}`;
      const shadowUrl = base.toString();
      base.pathname = `/${name}`;
      isolated = new Pool({ connectionString: base.toString(), max: 8 });
      const connected = await isolated.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      if (connected.rows[0]?.name !== name) {
        throw new Error("ISOLATION_GUARD_FAILED");
      }
      const migrations = join(import.meta.dirname, "../prisma/migrations");
      for (const entry of (await readdir(migrations, { withFileTypes: true }))
        .filter((value) => value.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))) {
        await isolated.query(
          await readFile(join(migrations, entry.name, "migration.sql"), "utf8"),
        );
      }
      await assertMigrationSchemaMatch({
        datasourceUrl: isolatedUrl,
        shadowDatabaseUrl: shadowUrl,
        migrations,
      });
      process.env.POSTGRES_DB = name;
      process.env.SOURCE_AUTHORIZATION_POLICY = "local-auto";
      process.env.DEPLOYMENT_PROFILE = "local";
      process.env.MEDIA_QUEUE_DISABLED = "1";
      prisma = new PrismaService();
      await prisma.$connect();
      @Module({
        controllers: [
          AssemblyRecipeController,
          AssemblyRenderController,
          EditorialApprovalController,
          EditorialExportController,
        ],
        providers: [
          { provide: PrismaService, useValue: prisma },
          { provide: JOB_DISPATCH, useValue: dispatch },
          { provide: ASSEMBLY_RENDER_ADMISSION_ENABLED, useValue: true },
          { provide: EDITORIAL_APPROVAL_ADMISSION_ENABLED, useValue: true },
          { provide: EDITORIAL_INTEGRATED_REVIEW_ENABLED, useValue: false },
          { provide: EDITORIAL_EXPORT_ADMISSION_ENABLED, useValue: true },
          { provide: OBJECT_STORAGE, useValue: storage },
          PrismaAssemblyRecipeRepository,
          PrismaAssemblyRenderRepository,
          PrismaEditorialApprovalRepository,
          PrismaEditorialExportRepository,
          {
            provide: ASSEMBLY_RECIPE_REPOSITORY,
            useExisting: PrismaAssemblyRecipeRepository,
          },
          {
            provide: ASSEMBLY_RENDER_REPOSITORY,
            useExisting: PrismaAssemblyRenderRepository,
          },
          {
            provide: EDITORIAL_APPROVAL_REPOSITORY,
            useExisting: PrismaEditorialApprovalRepository,
          },
          {
            provide: EDITORIAL_EXPORT_REPOSITORY,
            useExisting: PrismaEditorialExportRepository,
          },
          SaveAssemblyRecipe,
          GetAssemblyRecipe,
          GetAssemblyRecipeRevision,
          ListAssemblyRecipes,
          CreateAssemblyRender,
          GetAssemblyRender,
          GetAssemblyRenderContent,
          ListAssemblyRenders,
          CreateEditorialApproval,
          GetEditorialReview,
          ListEditorialApprovals,
          CreateEditorialExport,
          GetEditorialExport,
          GetEditorialExportContent,
          ListEditorialExports,
        ],
      })
      class IsolatedModule {}
      app = await NestFactory.create(IsolatedModule, {
        abortOnError: false,
        logger: false,
      });
      app.useGlobalPipes(
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
          exceptionFactory: (errors) =>
            new BadRequestException({
              code: "VALIDATION",
              message: JSON.stringify(errors),
            }),
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
      await app.init();
    }, 30_000);

    afterAll(async () => {
      await app?.close();
      await prisma?.$disconnect();
      await isolated?.end();
      if (created && /^content_factory_recipe_test_[a-f0-9]{32}$/.test(name)) {
        await admin.query(`DROP DATABASE "${name}"`);
        await admin.query(`DROP DATABASE "${shadowName}"`);
      }
      await admin?.end();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("saves, reloads, revises, lists, and preserves exact immutable snapshots without jobs", async () => {
      const cut = await readyCut();
      const intro = await readyAsset(cut, "INTRO");
      const outro = await readyAsset(cut, "OUTRO");
      const advertisement = await readyAsset(cut, "ADVERTISEMENT");
      const bannerOne = await readyAsset(cut, "BANNER");
      const bannerTwo = await readyAsset(cut, "BANNER");
      const jobsBefore = await prisma.pipelineJob.count();
      const objectsBefore = await prisma.mediaArtifact.count();
      const firstBody = fullRequest({
        intro,
        outro,
        advertisement,
        banners: [bannerOne, bannerTwo],
      });
      const { expectedRevision: _expectedRevision, ...firstConfiguration } =
        firstBody;
      const first = await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send(firstBody)
        .expect(200);
      expect(first.body).toMatchObject({
        projectId: cut.projectId,
        pipelineJobId: cut.jobId,
        cutResultArtifact: {
          id: cut.artifactId,
          sha256: "b".repeat(64),
          sizeBytes: "500",
          sourceId: cut.sourceId,
          sourceVersion: 1,
          recipeVersion: "stage1-cut-h264-v2",
          durationMs: 120_000,
        },
        revision: {
          revision: 1,
          schemaVersion: "horizontal-assembly-v1",
          configuration: firstConfiguration,
        },
        validation: { valid: true },
      });
      expect(JSON.stringify(first.body)).not.toContain("objectKey");
      expect(await prisma.pipelineJob.count()).toBe(jobsBefore);
      expect(await prisma.mediaArtifact.count()).toBe(objectsBefore);
      const reloaded = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .expect(200);
      expect(reloaded.body).toEqual(first.body);

      const secondBody = {
        ...firstBody,
        expectedRevision: 1,
        cta: { ...firstBody.cta, text: "Обновлённый CTA" },
      };
      const second = await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send(secondBody)
        .expect(200);
      expect(second.body.revision.revision).toBe(2);
      const historical = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe/revisions/1`)
        .expect(200);
      expect(historical.body).toEqual(first.body);
      const listed = await request(app.getHttpServer())
        .get(`/api/v1/projects/${cut.projectId}/assembly-recipes?limit=1`)
        .expect(200);
      expect(listed.body).toEqual({ items: [second.body], nextCursor: null });
      expect(await prisma.assemblyRecipeMutationRequest.count()).toBe(2);
      await expect(
        isolated.query(
          `INSERT INTO "AssemblyRecipeRevision" ("id", "recipeId", "revision", "configurationFingerprint", "ctaStartMs", "ctaEndMs", "ctaPosition") VALUES ($1, $2, 99, $3, 1, 2, 'TOP_LEFT')`,
          [randomUUID(), first.body.id as string, "e".repeat(64)],
        ),
      ).rejects.toThrow(/AssemblyRecipeRevision_cta_shape/);
    });

    it("converges concurrent same-key replay and rejects changed replay and stale CAS", async () => {
      const cut = await readyCut();
      const banner = await readyAsset(cut, "BANNER");
      const body = fullRequest({ banners: [banner] });
      const key = randomUUID();
      const [left, right] = await Promise.all([
        request(app.getHttpServer())
          .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
          .set("Idempotency-Key", key)
          .send(body),
        request(app.getHttpServer())
          .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
          .set("Idempotency-Key", key)
          .send(body),
      ]);
      expect([left.status, right.status]).toEqual([200, 200]);
      expect(left.body).toEqual(right.body);
      const recipe = await prisma.assemblyRecipe.findUniqueOrThrow({
        where: { pipelineJobId: cut.jobId },
        include: { revisions: { include: { mutationRequests: true } } },
      });
      expect(recipe.revisions).toHaveLength(1);
      expect(recipe.revisions[0]?.mutationRequests).toHaveLength(1);
      await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", key)
        .send({ ...body, cta: { ...body.cta, text: "changed" } })
        .expect(409)
        .expect(({ body: responseBody }) =>
          expect(responseBody.error.code).toBe("IDEMPOTENCY_CONFLICT"),
        );
      await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send({ ...body, cta: { ...body.cta, text: "stale" } })
        .expect(409)
        .expect(({ body: responseBody }) =>
          expect(responseBody.error.code).toBe("ASSEMBLY_REVISION_CONFLICT"),
        );
    });

    it("admits one exact render, converges requests, reloads, and serves bounded Range content", async () => {
      const cut = await readyCut();
      const intro = await readyAsset(cut, "INTRO");
      const saved = await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send(fullRequest({ intro }))
        .expect(200);
      const [left, right] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-renders`)
          .set("Idempotency-Key", randomUUID())
          .send({ recipeRevision: 1 }),
        request(app.getHttpServer())
          .post(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-renders`)
          .set("Idempotency-Key", randomUUID())
          .send({ recipeRevision: 1 }),
      ]);
      expect(
        [left.status, right.status],
        JSON.stringify([left.body, right.body]),
      ).toEqual([202, 202]);
      expect(left.body.id).toBe(right.body.id);
      expect(left.body).toMatchObject({
        projectId: cut.projectId,
        cutPipelineJobId: cut.jobId,
        recipeRevisionId: saved.body.revision.id,
        recipeRevision: 1,
        expectedDurationMs: 125_000,
        renderContractVersion: "horizontal-render-v1",
        job: { state: "QUEUED", attempt: 0, retryBudget: 2 },
        result: null,
      });
      expect(JSON.stringify(left.body)).not.toContain("objectKey");
      expect(await prisma.assemblyRenderIntent.count()).toBe(1);
      expect(await prisma.assemblyRenderRequest.count()).toBe(2);
      expect(
        await prisma.pipelineJob.count({
          where: {
            type: "ASSEMBLE_HORIZONTAL",
            assemblyRenderIntentId: left.body.id,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.jobAttempt.count({
          where: { job: { assemblyRenderIntentId: left.body.id } },
        }),
      ).toBe(1);
      expect(dispatch.dispatch).toHaveBeenCalledWith({
        jobId: left.body.job.id,
        attemptNumber: 1,
      });
      const reloaded = await request(app.getHttpServer())
        .get(`/api/v1/assembly-renders/${left.body.id}`)
        .expect(200);
      expect(reloaded.body).toEqual(left.body);
      const listed = await request(app.getHttpServer())
        .get(`/api/v1/projects/${cut.projectId}/assembly-renders?limit=1`)
        .expect(200);
      expect(listed.body).toEqual({ items: [left.body], nextCursor: null });
      await request(app.getHttpServer())
        .get(`/api/v1/assembly-renders/${left.body.id}/content`)
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("ASSEMBLY_RESULT_NOT_READY"),
        );
      await request(app.getHttpServer())
        .get(`/api/v1/assembly-renders/${randomUUID()}/content`)
        .expect(404)
        .expect(({ body }) =>
          expect(body.error.code).toBe("ASSEMBLY_RENDER_NOT_FOUND"),
        );

      const artifactId = randomUUID();
      await prisma.$transaction([
        prisma.mediaArtifact.create({
          data: {
            id: artifactId,
            projectId: cut.projectId,
            sourceId: cut.sourceId,
            role: "HORIZONTAL_ASSEMBLY_RESULT",
            status: "READY",
            objectKey: `test/assembly/${artifactId}.mp4`,
            sizeBytes: BigInt(content.length),
            sha256: "f".repeat(64),
            contentType: "video/mp4",
            lineageSourceId: cut.sourceId,
            lineageSourceVersion: 1,
            recipeVersion: "horizontal-render-v1",
            pipelineJobId: left.body.job.id,
            ffmpegVersion: "ffmpeg-test",
            outputFilename: "готовое-видео.mp4",
          },
        }),
        prisma.assemblyRenderResult.create({
          data: {
            id: randomUUID(),
            renderIntentId: left.body.id,
            artifactId,
            durationMs: 125_000,
            width: 1280,
            height: 720,
            fpsNumerator: 25,
            fpsDenominator: 1,
            videoCodec: "h264",
            pixelFormat: "yuv420p",
            audioCodec: "aac",
            audioSampleRate: 48_000,
            audioChannels: 2,
            ffmpegVersion: "ffmpeg-test",
            ffprobeVersion: "ffprobe-test",
            integratedLoudnessLufs: -14,
            truePeakDbtp: -1.5,
            normalizationProfileResult: "NORMALIZED",
            completedAt: new Date(),
          },
        }),
        prisma.pipelineJob.update({
          where: { id: left.body.job.id },
          data: { state: "READY", finishedAt: new Date() },
        }),
      ]);
      const ranged = await request(app.getHttpServer())
        .get(`/api/v1/assembly-renders/${left.body.id}/content`)
        .set("Range", "bytes=1-3")
        .expect(206);
      expect(ranged.headers["content-range"]).toBe(
        `bytes 1-3/${content.length}`,
      );
      expect(ranged.headers["accept-ranges"]).toBe("bytes");
      expect(ranged.body).toEqual(content.subarray(1, 4));
      await request(app.getHttpServer())
        .get(`/api/v1/assembly-renders/${left.body.id}/content`)
        .set("Range", `bytes=${content.length}-`)
        .expect(416)
        .expect("Content-Range", `bytes */${content.length}`);

      storage.readObject.mockClear();
      process.env.SOURCE_AUTHORIZATION_POLICY = "manual";
      try {
        await request(app.getHttpServer())
          .get(`/api/v1/assembly-renders/${left.body.id}`)
          .expect(403);
        await request(app.getHttpServer())
          .get(`/api/v1/projects/${cut.projectId}/assembly-renders`)
          .expect(403);
        await request(app.getHttpServer())
          .get(`/api/v1/assembly-renders/${left.body.id}/content`)
          .expect(403);
        expect(storage.readObject).not.toHaveBeenCalled();
      } finally {
        process.env.SOURCE_AUTHORIZATION_POLICY = "local-auto";
      }
    });

    it("fails closed for invalid timing, kind, state, project, and cut lineage with zero partial writes", async () => {
      const cut = await readyCut();
      const other = await readyCut();
      const wrongKind = await readyAsset(cut, "OUTRO");
      const crossProject = await readyAsset(other, "INTRO");
      const pending = await readyAsset(cut, "INTRO", "PROBE_PENDING");
      const invalidBodies = [
        { ...fullRequest({ intro: wrongKind }), introAssetId: wrongKind },
        { ...fullRequest({ intro: crossProject }), introAssetId: crossProject },
        { ...fullRequest({ intro: pending }), introAssetId: pending },
        {
          ...fullRequest({}),
          advertisement: { assetId: wrongKind, insertAtMs: 120_000 },
        },
        {
          ...fullRequest({}),
          banners: [
            {
              clientItemId: "duplicate",
              assetId: await readyAsset(cut, "BANNER"),
              startMs: 0,
              endMs: 1_000,
              position: "TOP_LEFT",
            },
            {
              clientItemId: "duplicate",
              assetId: await readyAsset(cut, "BANNER"),
              startMs: 2_000,
              endMs: 3_000,
              position: "TOP_RIGHT",
            },
          ],
        },
      ];
      for (const [index, body] of invalidBodies.entries()) {
        const response = await request(app.getHttpServer())
          .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
          .set("Idempotency-Key", `invalid-recipe-${index}`)
          .send(body);
        expect([409, 422]).toContain(response.status);
      }
      expect(
        await prisma.assemblyRecipe.count({
          where: { pipelineJobId: cut.jobId },
        }),
      ).toBe(0);
      await prisma.mediaArtifact.update({
        where: { id: cut.artifactId },
        data: { recipeVersion: "tampered" },
      });
      await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send(fullRequest({}))
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("CUT_RESULT_LINEAGE_INVALID"),
        );
      expect(
        await prisma.assemblyRecipe.count({
          where: { pipelineJobId: cut.jobId },
        }),
      ).toBe(0);

      const staleSource = await readyCut();
      await prisma.videoSource.update({
        where: { id: staleSource.sourceId },
        data: { sourceVersion: 2 },
      });
      await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${staleSource.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send(fullRequest({}))
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("CUT_RESULT_LINEAGE_INVALID"),
        );
      expect(
        await prisma.assemblyRecipe.count({
          where: { pipelineJobId: staleSource.jobId },
        }),
      ).toBe(0);

      const crossProjectCut = await readyCut();
      const hostProject = await readyCut();
      await prisma.pipelineJob.update({
        where: { id: crossProjectCut.jobId },
        data: { projectId: hostProject.projectId },
      });
      await prisma.mediaArtifact.update({
        where: { id: crossProjectCut.artifactId },
        data: { projectId: hostProject.projectId },
      });
      const writesBefore = {
        recipes: await prisma.assemblyRecipe.count(),
        revisions: await prisma.assemblyRecipeRevision.count(),
        mutations: await prisma.assemblyRecipeMutationRequest.count(),
      };
      await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${crossProjectCut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send(fullRequest({}))
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("CUT_RESULT_LINEAGE_INVALID"),
        );
      expect(await prisma.assemblyRecipe.count()).toBe(writesBefore.recipes);
      expect(await prisma.assemblyRecipeRevision.count()).toBe(
        writesBefore.revisions,
      );
      expect(await prisma.assemblyRecipeMutationRequest.count()).toBe(
        writesBefore.mutations,
      );
    });

    it("enforces current policy and detects tampered persisted snapshots", async () => {
      const cut = await readyCut();
      const intro = await readyAsset(cut, "INTRO");
      const saved = await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send(fullRequest({ intro }))
        .expect(200);
      process.env.SOURCE_AUTHORIZATION_POLICY = "manual";
      await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .expect(403);
      process.env.SOURCE_AUTHORIZATION_POLICY = "local-auto";
      await prisma.assemblyRecipeRevision.update({
        where: { id: saved.body.revision.id as string },
        data: { configurationFingerprint: "d".repeat(64) },
      });
      await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("ASSEMBLY_RECIPE_LINEAGE_INVALID"),
        );
      await expect(
        isolated.query(
          `UPDATE "MontageAsset" SET "rightsDeclaration"='tampered' WHERE "id"=$1`,
          [intro],
        ),
      ).rejects.toThrow();
    });

    it("previews, approves, reloads, lists, and converges exact approval requests without creating jobs", async () => {
      const candidate = await readyApprovalCandidate();
      const review = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      expect(review.body).toMatchObject({
        reviewContractVersion: "editorial-review-candidate-v2",
        integratedReviewEnabled: false,
        projectId: candidate.cut.projectId,
        cutPipelineJobId: candidate.cut.jobId,
        approvable: true,
        blockers: [],
        editorial: {
          revision: 1,
          title: "Тестовый заголовок",
          thumbnail: {
            contentUrl: `/api/v1/projects/${candidate.cut.projectId}/editorial-assets/thumbnails/${candidate.thumbnailId}/content`,
          },
        },
        recipe: { revision: 1 },
        render: { id: candidate.renderId, resultId: candidate.resultId },
        processingMetrics: {
          metricsSchemaVersion: "approval-metrics-v1",
          timestampBasisVersion: "persisted-job-attempt-v1",
          cut: {
            initialQueueWaitMs: 10_000,
            retryWaitMs: 20_000,
            activeAttemptMs: 80_000,
            firstStartToFinishMs: 100_000,
            attemptCount: 2,
            retryCount: 1,
          },
          directProviderCostMinor: 0,
          costCurrency: "RUB",
          costBasisVersion: "local-direct-provider-cost-v1",
        },
      });
      expect(JSON.stringify(review.body)).not.toContain("objectKey");
      const body = {
        editorialRevision: 1,
        candidateFingerprint: review.body.candidateFingerprint as string,
        manualAttentionMs: 245_000,
        attentionMeasurementVersion: "foreground-preview-v1",
      };
      const jobsBefore = await prisma.pipelineJob.count();
      const key = randomUUID();
      const first = await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", key)
        .send(body)
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", key)
        .send(body)
        .expect(201);
      expect(replay.body).toEqual(first.body);
      expect(first.body).toMatchObject({
        approvalContractVersion: "manual-horizontal-approval-v1",
        candidateFingerprint: review.body.candidateFingerprint,
        state: "CURRENT",
        staleReasons: [],
        metrics: {
          manualAttentionMs: 245_000,
          attentionMeasurementVersion: "foreground-preview-v1",
          outputBytes: "700",
        },
      });
      const [concurrentOne, concurrentTwo] = await Promise.all([
        request(app.getHttpServer())
          .post(
            `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
          )
          .set("Idempotency-Key", randomUUID())
          .send(body),
        request(app.getHttpServer())
          .post(
            `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
          )
          .set("Idempotency-Key", randomUUID())
          .send(body),
      ]);
      expect([concurrentOne.status, concurrentTwo.status]).toEqual([201, 201]);
      expect(concurrentOne.body.id).toBe(first.body.id);
      expect(concurrentTwo.body.id).toBe(first.body.id);
      expect(await prisma.editorialApproval.count()).toBe(1);
      expect(await prisma.editorialOperationRequest.count()).toBe(3);
      expect(await prisma.pipelineJob.count()).toBe(jobsBefore);

      const reloaded = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      expect(reloaded.body.currentApproval).toEqual(first.body);
      expect(reloaded.body.latestApproval).toEqual(first.body);
      const listed = await request(app.getHttpServer())
        .get(
          `/api/v1/projects/${candidate.cut.projectId}/editorial-approvals?limit=1`,
        )
        .expect(200);
      expect(listed.body).toEqual({ items: [first.body], nextCursor: null });
    });

    it("recovers an exact approval after an unknown transaction outcome and keeps target mismatches generic", async () => {
      const candidate = await readyApprovalCandidate();
      const differentTarget = await readyApprovalCandidate();
      const review = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      const differentReview = await request(app.getHttpServer())
        .get(
          `/api/v1/pipeline-jobs/${differentTarget.cut.jobId}/editorial-review`,
        )
        .expect(200);
      const key = randomUUID();
      const body = {
        editorialRevision: 1,
        candidateFingerprint: review.body.candidateFingerprint as string,
        manualAttentionMs: 15_000,
        attentionMeasurementVersion: "foreground-preview-v1",
      };
      const originalTransaction = prisma.$transaction.bind(prisma);
      const transactionSpy = vi
        .spyOn(prisma, "$transaction")
        .mockImplementationOnce((async (...args: unknown[]) => {
          await Reflect.apply(originalTransaction, prisma, args);
          throw new Error("SIMULATED_COMMIT_OUTCOME_UNKNOWN");
        }) as never);
      const ledgerReadSpy = vi.spyOn(
        prisma.editorialOperationRequest,
        "findUnique",
      );
      let recovered: request.Response;
      try {
        recovered = await request(app.getHttpServer())
          .post(
            `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
          )
          .set("Idempotency-Key", key)
          .send(body)
          .expect(201);
      } finally {
        transactionSpy.mockRestore();
      }
      expect(ledgerReadSpy).toHaveBeenCalledWith({
        where: { idempotencyKey: key },
      });
      ledgerReadSpy.mockRestore();
      const operation =
        await prisma.editorialOperationRequest.findUniqueOrThrow({
          where: { idempotencyKey: key },
        });
      expect(operation.approvalId).toBe(recovered.body.id);
      expect(
        await prisma.editorialApproval.count({
          where: { projectId: candidate.cut.projectId },
        }),
      ).toBe(1);
      expect(
        await prisma.editorialOperationRequest.count({
          where: { idempotencyKey: key },
        }),
      ).toBe(1);

      const exactReplay = await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", key)
        .send(body)
        .expect(201);
      expect(exactReplay.body).toEqual(recovered.body);

      const conflict = await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${differentTarget.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", key)
        .send({
          ...body,
          candidateFingerprint: differentReview.body.candidateFingerprint,
        })
        .expect(409);
      expect(conflict.body).toEqual({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "This key belongs to a different editorial operation.",
        },
      });
      expect(JSON.stringify(conflict.body)).not.toContain(candidate.renderId);
      expect(JSON.stringify(conflict.body)).not.toContain(
        differentTarget.renderId,
      );
      expect(JSON.stringify(conflict.body)).not.toContain(recovered.body.id);
      expect(
        await prisma.editorialApproval.count({
          where: { projectId: candidate.cut.projectId },
        }),
      ).toBe(1);
      expect(
        await prisma.editorialOperationRequest.count({
          where: { idempotencyKey: key },
        }),
      ).toBe(1);
    });

    it("returns HTTP 503 with zero writes while editorial approval admission is disabled", async () => {
      const candidate = await readyApprovalCandidate();
      const review = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      const approvalCount = await prisma.editorialApproval.count();
      const operationCount = await prisma.editorialOperationRequest.count();
      const useCase = app.get(CreateEditorialApproval) as unknown as {
        admissionEnabled: boolean;
      };
      useCase.admissionEnabled = false;
      try {
        await request(app.getHttpServer())
          .post(
            `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
          )
          .set("Idempotency-Key", randomUUID())
          .send({
            editorialRevision: 1,
            candidateFingerprint: review.body.candidateFingerprint,
            manualAttentionMs: 1_000,
            attentionMeasurementVersion: "foreground-preview-v1",
          })
          .expect(503)
          .expect(({ body }) =>
            expect(body.error).toEqual({
              code: "EDITORIAL_APPROVAL_DISABLED",
              message: "Editorial approval admission is temporarily disabled.",
            }),
          );
      } finally {
        useCase.admissionEnabled = true;
      }
      expect(await prisma.editorialApproval.count()).toBe(approvalCount);
      expect(await prisma.editorialOperationRequest.count()).toBe(
        operationCount,
      );
    });

    it("paginates project approvals and controls invalid cursors and missing targets", async () => {
      const candidates = [await readyApprovalCandidate()];
      const existingSource = {
        projectId: candidates[0]!.cut.projectId,
        sourceId: candidates[0]!.cut.sourceId,
      };
      candidates.push(
        await readyApprovalCandidate({ existingSource }),
        await readyApprovalCandidate({ existingSource }),
      );
      const approvals: request.Response[] = [];
      for (const candidate of candidates) {
        const review = await request(app.getHttpServer())
          .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
          .expect(200);
        approvals.push(
          await request(app.getHttpServer())
            .post(
              `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
            )
            .set("Idempotency-Key", randomUUID())
            .send({
              editorialRevision: 1,
              candidateFingerprint: review.body.candidateFingerprint,
              manualAttentionMs: 1_000,
              attentionMeasurementVersion: "foreground-preview-v1",
            })
            .expect(201),
        );
      }
      for (const [index, approval] of approvals.entries()) {
        await prisma.editorialApproval.update({
          where: { id: approval.body.id as string },
          data: {
            approvedAt: new Date(`2026-01-01T00:00:0${index + 1}.000Z`),
          },
        });
      }

      const firstPage = await request(app.getHttpServer())
        .get(
          `/api/v1/projects/${existingSource.projectId}/editorial-approvals?limit=2`,
        )
        .expect(200);
      expect(
        firstPage.body.items.map((item: { id: string }) => item.id),
      ).toEqual([approvals[2]!.body.id, approvals[1]!.body.id]);
      expect(firstPage.body.nextCursor).toBe(approvals[1]!.body.id);
      const secondPage = await request(app.getHttpServer())
        .get(
          `/api/v1/projects/${existingSource.projectId}/editorial-approvals?limit=2&cursor=${firstPage.body.nextCursor as string}`,
        )
        .expect(200);
      expect(
        secondPage.body.items.map((item: { id: string }) => item.id),
      ).toEqual([approvals[0]!.body.id]);
      expect(secondPage.body.nextCursor).toBeNull();

      await request(app.getHttpServer())
        .get(
          `/api/v1/projects/${existingSource.projectId}/editorial-approvals?cursor=not-a-uuid`,
        )
        .expect(400);
      await request(app.getHttpServer())
        .get(
          `/api/v1/projects/${existingSource.projectId}/editorial-approvals?cursor=${randomUUID()}`,
        )
        .expect(400)
        .expect(({ body }) =>
          expect(body.error.code).toBe("EDITORIAL_APPROVAL_CURSOR_INVALID"),
        );

      const missingId = randomUUID();
      await request(app.getHttpServer())
        .get(`/api/v1/projects/${missingId}/editorial-approvals`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${missingId}/editorial-review`)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/assembly-renders/${missingId}/editorial-approvals`)
        .set("Idempotency-Key", randomUUID())
        .send({
          editorialRevision: 1,
          candidateFingerprint: "f".repeat(64),
          manualAttentionMs: 1_000,
          attentionMeasurementVersion: "foreground-preview-v1",
        })
        .expect(404);
    });

    it("rejects global idempotency reuse across path, project, operation, and attention tuple", async () => {
      const first = await readyApprovalCandidate();
      const firstReview = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${first.cut.jobId}/editorial-review`)
        .expect(200);
      const body = {
        editorialRevision: 1,
        candidateFingerprint: firstReview.body.candidateFingerprint as string,
        manualAttentionMs: 1_000,
        attentionMeasurementVersion: "foreground-preview-v1",
      };
      for (const manualAttentionMs of [-1, 28_800_001, 1.5]) {
        await request(app.getHttpServer())
          .post(
            `/api/v1/assembly-renders/${first.renderId}/editorial-approvals`,
          )
          .set("Idempotency-Key", randomUUID())
          .send({ ...body, manualAttentionMs })
          .expect(400);
      }
      await request(app.getHttpServer())
        .post(`/api/v1/assembly-renders/${first.renderId}/editorial-approvals`)
        .set("Idempotency-Key", randomUUID())
        .send({ ...body, attentionMeasurementVersion: "browser-clock-v0" })
        .expect(400);
      expect(
        await prisma.editorialApproval.count({
          where: { projectId: first.cut.projectId },
        }),
      ).toBe(0);
      expect(
        await prisma.editorialOperationRequest.count({
          where: { resolvedProjectId: first.cut.projectId },
        }),
      ).toBe(0);
      const key = randomUUID();
      await request(app.getHttpServer())
        .post(`/api/v1/assembly-renders/${first.renderId}/editorial-approvals`)
        .set("Idempotency-Key", key)
        .send(body)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/assembly-renders/${first.renderId}/editorial-approvals`)
        .set("Idempotency-Key", key)
        .send({ ...body, manualAttentionMs: 1_001 })
        .expect(409)
        .expect(({ body: responseBody }) =>
          expect(responseBody.error.code).toBe("IDEMPOTENCY_CONFLICT"),
        );

      const revisedRecipe = await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${first.cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send({
          ...fullRequest({}),
          expectedRevision: 1,
          cta: {
            ...fullRequest({}).cta,
            text: "Другой exact render",
          },
        })
        .expect(200);
      const sameProjectRender = await request(app.getHttpServer())
        .post(`/api/v1/pipeline-jobs/${first.cut.jobId}/assembly-renders`)
        .set("Idempotency-Key", randomUUID())
        .send({ recipeRevision: revisedRecipe.body.revision.revision })
        .expect(202);
      await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${sameProjectRender.body.id}/editorial-approvals`,
        )
        .set("Idempotency-Key", key)
        .send(body)
        .expect(409)
        .expect(({ body: responseBody }) =>
          expect(responseBody.error.code).toBe("IDEMPOTENCY_CONFLICT"),
        );

      const second = await readyApprovalCandidate();
      const secondReview = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${second.cut.jobId}/editorial-review`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/assembly-renders/${second.renderId}/editorial-approvals`)
        .set("Idempotency-Key", key)
        .send({
          ...body,
          candidateFingerprint: secondReview.body.candidateFingerprint,
        })
        .expect(409)
        .expect(({ body: responseBody }) =>
          expect(responseBody.error.code).toBe("IDEMPOTENCY_CONFLICT"),
        );

      // Cross-operation reuse is covered by the Stage 2e export lifecycle
      // below, now that export rows have a real foreign key target.
    });

    it("derives stale metadata, recipe, authorization, and rights states without mutating approval history", async () => {
      const candidate = await readyApprovalCandidate({ withBanner: true });
      const review = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      const approvalKey = randomUUID();
      const approvalBody = {
        editorialRevision: 1,
        candidateFingerprint: review.body.candidateFingerprint,
        manualAttentionMs: 9_000,
        attentionMeasurementVersion: "foreground-preview-v1",
      };
      const approved = await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", approvalKey)
        .send(approvalBody)
        .expect(201);
      const storedBefore = await prisma.editorialApproval.findUniqueOrThrow({
        where: { id: approved.body.id as string },
      });

      const firstEditorialRevision =
        await prisma.editorialPackageRevision.findFirstOrThrow({
          where: { packageId: candidate.editorialPackageId, revision: 1 },
        });
      await prisma.$transaction([
        prisma.editorialPackageRevision.create({
          data: {
            id: randomUUID(),
            packageId: candidate.editorialPackageId,
            revision: 2,
            processingTemplateRevisionId:
              firstEditorialRevision.processingTemplateRevisionId,
            title: "Новая редакция",
            description: firstEditorialRevision.description,
            tags: firstEditorialRevision.tags ?? undefined,
            thumbnailAssetId: firstEditorialRevision.thumbnailAssetId,
          },
        }),
        prisma.editorialPackage.update({
          where: { id: candidate.editorialPackageId },
          data: { currentRevision: 2 },
        }),
      ]);
      let listed = await request(app.getHttpServer())
        .get(`/api/v1/projects/${candidate.cut.projectId}/editorial-approvals`)
        .expect(200);
      expect(listed.body.items[0]).toMatchObject({
        id: approved.body.id,
        state: "STALE",
        staleReasons: ["EDITORIAL_REVISION_CHANGED"],
      });

      await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send({
          ...fullRequest({ banners: [candidate.bannerId!] }),
          expectedRevision: 1,
          cta: {
            ...fullRequest({}).cta,
            text: "Новая версия рецепта",
          },
        })
        .expect(200);
      await prisma.sourceAuthorization.update({
        where: {
          sourceId_sourceVersion: {
            sourceId: candidate.cut.sourceId,
            sourceVersion: 1,
          },
        },
        data: {
          status: "NOT_REVIEWED",
          basis: null,
          declarationVersion: null,
          decidedAt: null,
        },
      });
      process.env.SOURCE_AUTHORIZATION_POLICY = "manual";
      listed = await request(app.getHttpServer())
        .get(`/api/v1/projects/${candidate.cut.projectId}/editorial-approvals`)
        .expect(200);
      expect(listed.body.items[0].staleReasons).toEqual([
        "EDITORIAL_REVISION_CHANGED",
        "ASSEMBLY_RECIPE_REVISION_CHANGED",
        "AUTHORIZATION_REQUIRED",
        "ASSET_RIGHTS_REQUIRED",
      ]);
      await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", approvalKey)
        .send(approvalBody)
        .expect(201)
        .expect(({ body: replayBody }) =>
          expect(replayBody).toMatchObject({
            id: approved.body.id,
            state: "STALE",
            staleReasons: listed.body.items[0].staleReasons,
          }),
        );
      process.env.SOURCE_AUTHORIZATION_POLICY = "local-auto";
      expect(
        await prisma.editorialApproval.findUniqueOrThrow({
          where: { id: approved.body.id as string },
        }),
      ).toEqual(storedBefore);
    });

    it("reports recovery-written timestamp defects as field-specific null metrics without rewriting them", async () => {
      const candidate = await readyApprovalCandidate();
      const attempt = await prisma.jobAttempt.findFirstOrThrow({
        where: {
          jobId: candidate.assemblyJobId,
          attemptNumber: 2,
        },
      });
      const invalidStartedAt = new Date("2026-01-01T00:00:35.000Z");
      const invalidFinishedAt = new Date("2026-01-01T00:00:34.000Z");
      await prisma.jobAttempt.update({
        where: { id: attempt.id },
        data: { startedAt: invalidStartedAt, finishedAt: invalidFinishedAt },
      });
      const review = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      expect(review.body).toMatchObject({
        approvable: false,
        blockers: ["PROCESSING_METRICS_INCOMPLETE"],
        processingMetrics: {
          assembly: {
            initialQueueWaitMs: 10_000,
            retryWaitMs: null,
            activeAttemptMs: null,
            firstStartToFinishMs: 100_000,
            attemptCount: 2,
            retryCount: 1,
          },
          incompleteReasons: [
            "ASSEMBLY_RETRY_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED",
            "ASSEMBLY_ACTIVE_ATTEMPT_TIMESTAMP_ORDER_INVALID",
          ],
        },
      });
      expect(
        await prisma.jobAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        }),
      ).toMatchObject({
        startedAt: invalidStartedAt,
        finishedAt: invalidFinishedAt,
      });
    });

    it("creates one durable editorial export, recovers status, serves Range, and closes the stale gate", async () => {
      const candidate = await readyApprovalCandidate();
      const review = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      const approvalKey = randomUUID();
      const approval = await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", approvalKey)
        .send({
          editorialRevision: 1,
          candidateFingerprint: review.body.candidateFingerprint,
          manualAttentionMs: 1_000,
          attentionMeasurementVersion: "foreground-preview-v1",
        })
        .expect(201);
      const exportKey = randomUUID();
      dispatch.dispatch.mockRejectedValueOnce(new Error("redis unavailable"));
      const first = await request(app.getHttpServer())
        .post(`/api/v1/editorial-approvals/${approval.body.id}/exports`)
        .set("Idempotency-Key", exportKey)
        .expect(202);
      const replay = await request(app.getHttpServer())
        .post(`/api/v1/editorial-approvals/${approval.body.id}/exports`)
        .set("Idempotency-Key", exportKey)
        .expect(202);
      expect(replay.body).toEqual(first.body);
      expect(first.body).toMatchObject({
        approvalId: approval.body.id,
        approvalCurrent: true,
        exportContractVersion: "editorial-export-zip-v1",
        job: { state: "QUEUED", attempt: 0 },
        result: null,
      });
      expect(await prisma.editorialExportIntent.count()).toBe(1);
      expect(
        await prisma.pipelineJob.count({
          where: { type: "EXPORT_EDITORIAL_PACKAGE" },
        }),
      ).toBe(1);
      expect(dispatch.dispatch).toHaveBeenCalledWith({
        jobId: first.body.job.id,
        attemptNumber: 1,
      });
      const reconciliation = new PrismaPipelineRepository(prisma);
      await expect(
        reconciliation.getRunnableJobsByIds([first.body.job.id as string]),
      ).resolves.toEqual([
        { jobId: first.body.job.id as string, attemptNumber: 1 },
      ]);
      await expect(
        reconciliation.isDeliveryRunnable({
          jobId: first.body.job.id as string,
          attemptNumber: 1,
        }),
      ).resolves.toBe(true);

      const concurrent = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/editorial-approvals/${approval.body.id}/exports`)
          .set("Idempotency-Key", randomUUID()),
        request(app.getHttpServer())
          .post(`/api/v1/editorial-approvals/${approval.body.id}/exports`)
          .set("Idempotency-Key", randomUUID()),
      ]);
      expect(concurrent.map((value) => value.status)).toEqual([202, 202]);
      expect(concurrent.map((value) => value.body.id)).toEqual([
        first.body.id,
        first.body.id,
      ]);
      expect(await prisma.editorialExportIntent.count()).toBe(1);

      await request(app.getHttpServer())
        .post(`/api/v1/editorial-approvals/${approval.body.id}/exports`)
        .set("Idempotency-Key", approvalKey)
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT"),
        );

      const expiredLease = new Date(Date.now() - 60_000);
      const leaseToken = randomUUID();
      await prisma.pipelineJob.update({
        where: { id: first.body.job.id as string },
        data: {
          state: "PROCESSING",
          attemptCount: 1,
          leaseOwner: "lost-worker",
          leaseToken,
          leaseExpiresAt: expiredLease,
          heartbeatAt: expiredLease,
        },
      });
      await prisma.jobAttempt.updateMany({
        where: { jobId: first.body.job.id as string, attemptNumber: 1 },
        data: {
          state: "PROCESSING",
          workerId: "lost-worker",
          leaseToken,
          startedAt: expiredLease,
          heartbeatAt: expiredLease,
        },
      });
      await expect(reconciliation.recoverExpiredLeases(10)).resolves.toEqual([
        { jobId: first.body.job.id as string, attemptNumber: 2 },
      ]);
      await expect(
        reconciliation.getRunnableJobsByIds([first.body.job.id as string]),
      ).resolves.toEqual([]);
      await prisma.pipelineJob.update({
        where: { id: first.body.job.id as string },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      await expect(
        reconciliation.getRunnableJobsByIds([first.body.job.id as string]),
      ).resolves.toEqual([
        { jobId: first.body.job.id as string, attemptNumber: 2 },
      ]);

      const artifactId = randomUUID();
      await prisma.pipelineJob.update({
        where: { id: first.body.job.id as string },
        data: {
          state: "READY",
          finishedAt: new Date(),
          attemptCount: 1,
          nextAttemptAt: null,
        },
      });
      await prisma.mediaArtifact.create({
        data: {
          id: artifactId,
          projectId: candidate.cut.projectId,
          sourceId: candidate.cut.sourceId,
          role: "EDITORIAL_EXPORT_PACKAGE",
          status: "READY",
          objectKey: `test/export/${artifactId}.zip`,
          sizeBytes: BigInt(content.length),
          sha256: "e".repeat(64),
          contentType: "application/zip",
          lineageSourceId: candidate.cut.sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "editorial-export-zip-v1",
          pipelineJobId: first.body.job.id as string,
          outputFilename: "editorial-package.zip",
        },
      });
      await prisma.editorialExportResult.create({
        data: {
          id: randomUUID(),
          exportIntentId: first.body.id as string,
          pipelineJobId: first.body.job.id as string,
          artifactId,
          filename: "editorial-package.zip",
          archiveSizeBytes: BigInt(content.length),
          archiveSha256: "e".repeat(64),
          manifest: { manifestSchemaVersion: "editorial-export-manifest-v1" },
          completedAt: new Date(),
        },
      });
      const ready = await request(app.getHttpServer())
        .get(`/api/v1/editorial-exports/${first.body.id}`)
        .expect(200);
      expect(ready.body).toMatchObject({
        job: { state: "READY" },
        result: {
          filename: "editorial-package.zip",
          sizeBytes: String(content.length),
          sha256: "e".repeat(64),
          downloadUrl: `/api/v1/editorial-exports/${first.body.id}/content`,
        },
      });
      const range = await request(app.getHttpServer())
        .get(`/api/v1/editorial-exports/${first.body.id}/content`)
        .set("Range", "bytes=1-3")
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => callback(null, Buffer.concat(chunks)));
          response.on("error", callback);
        })
        .expect(206);
      expect(range.body).toEqual(content.subarray(1, 4));
      expect(range.headers["content-type"]).toMatch(/^application\/zip/);
      expect(range.headers["content-disposition"]).toContain("attachment");

      const listed = await request(app.getHttpServer())
        .get(`/api/v1/projects/${candidate.cut.projectId}/editorial-exports`)
        .expect(200);
      expect(listed.body.items[0].id).toBe(first.body.id);
      await prisma.editorialPackage.update({
        where: { id: candidate.editorialPackageId },
        data: { currentRevision: 2 },
      });
      await request(app.getHttpServer())
        .get(`/api/v1/editorial-exports/${first.body.id}`)
        .expect(200)
        .expect(({ body }) => expect(body.approvalCurrent).toBe(false));
      await request(app.getHttpServer())
        .get(`/api/v1/editorial-exports/${first.body.id}/content`)
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("EDITORIAL_EXPORT_NOT_READY"),
        );
      await request(app.getHttpServer())
        .post(`/api/v1/editorial-approvals/${approval.body.id}/exports`)
        .set("Idempotency-Key", randomUUID())
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("EDITORIAL_APPROVAL_STALE"),
        );
    });

    it("keeps an AI-derived historical v1 approval readable but blocks new export admission", async () => {
      const candidate = await readyApprovalCandidate();
      const review = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      const approval = await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", randomUUID())
        .send({
          editorialRevision: 1,
          candidateFingerprint: review.body.candidateFingerprint,
          manualAttentionMs: 1_000,
          attentionMeasurementVersion: "foreground-preview-v1",
        })
        .expect(201);
      await prisma.editorialComponentProvenance.create({
        data: {
          id: randomUUID(),
          packageRevisionId: approval.body.editorialPackageRevisionId,
          component: "METADATA",
          mode: "AI_ASSISTED",
          basisVersion: "historical-ai-v1",
        },
      });
      await request(app.getHttpServer())
        .get(
          `/api/v1/projects/${candidate.cut.projectId}/editorial-approvals?limit=10`,
        )
        .expect(200)
        .expect(({ body }) =>
          expect(body.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: approval.body.id }),
            ]),
          ),
        );
      await request(app.getHttpServer())
        .post(`/api/v1/editorial-approvals/${approval.body.id}/exports`)
        .set("Idempotency-Key", randomUUID())
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("EDITORIAL_APPROVAL_STALE"),
        );
    });

    it("creates and replays an exact manual v2 approval through the real repository", async () => {
      const candidate = await readyApprovalCandidate();
      await prisma.editorialComponentProvenance.createMany({
        data: ["METADATA", "THUMBNAIL"].map((component) => ({
          id: randomUUID(),
          packageRevisionId: candidate.editorialRevisionId,
          component: component as "METADATA" | "THUMBNAIL",
          mode: "MANUAL" as const,
          basisVersion: "manual-editorial-v1",
        })),
      });
      const repository = new PrismaEditorialApprovalRepository(prisma, true);
      const review = await repository.getReview(candidate.cut.jobId);
      expect(review).toMatchObject({
        reviewContractVersion: "editorial-review-candidate-v2",
        integratedReviewEnabled: true,
        workflowMode: "MANUAL",
        approvable: true,
        components: {
          metadata: { mode: "MANUAL" },
          thumbnail: { mode: "MANUAL" },
        },
      });
      if (!review?.candidateFingerprint)
        throw new Error("v2 review was not built");
      const idempotencyKey = randomUUID();
      const input = {
        approvalId: randomUUID(),
        operationRequestId: randomUUID(),
        renderId: candidate.renderId,
        editorialRevision: 1,
        candidateFingerprint: review.candidateFingerprint,
        approvalContractVersion: "human-horizontal-approval-v2" as const,
        attention: {
          schemaVersion: "operator-attention-v2" as const,
          preparationForegroundMs: 700,
          finalReviewForegroundMs: 900,
        },
        idempotencyKey,
      };
      const created = await repository.create(input);
      const replayed = await repository.create({
        ...input,
        approvalId: randomUUID(),
        operationRequestId: randomUUID(),
      });
      expect(replayed.id).toBe(created.id);
      expect(created).toMatchObject({
        approvalContractVersion: "human-horizontal-approval-v2",
        state: "CURRENT",
        economicsV2: {
          workflowMode: "MANUAL",
          attention: {
            preparationForegroundMs: 700,
            finalReviewForegroundMs: 900,
            totalOperatorAttentionMs: 1_600,
          },
        },
      });
      expect(created.componentSnapshots).toHaveLength(2);
      expect(
        JSON.stringify(created, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).not.toContain("objectKey");

      const other = await readyApprovalCandidate();
      await prisma.editorialComponentProvenance.createMany({
        data: ["METADATA", "THUMBNAIL"].map((component) => ({
          id: randomUUID(),
          packageRevisionId: other.editorialRevisionId,
          component: component as "METADATA" | "THUMBNAIL",
          mode: "MANUAL" as const,
          basisVersion: "manual-editorial-v1",
        })),
      });
      const otherReview = await repository.getReview(other.cut.jobId);
      if (!otherReview?.candidateFingerprint)
        throw new Error("cross-cut review was not built");
      await expect(
        repository.create({
          ...input,
          approvalId: randomUUID(),
          operationRequestId: randomUUID(),
          idempotencyKey: randomUUID(),
          candidateFingerprint: otherReview.candidateFingerprint,
        }),
      ).rejects.toBeInstanceOf(EditorialApprovalCandidateConflictError);
    });

    it.each(["MIXED", "AI_ASSISTED"] as const)(
      "creates and reloads an exact %s v2 approval without private research data",
      async (workflow) => {
        const candidate = await readyApprovalCandidate();
        const assisted = await addAssistedProvenance(candidate, workflow);
        const repository = new PrismaEditorialApprovalRepository(prisma, true);
        const review = await repository.getReview(candidate.cut.jobId);
        expect(review).toMatchObject({
          reviewContractVersion: "editorial-review-candidate-v2",
          integratedReviewEnabled: true,
          workflowMode: workflow,
          approvable: true,
          components: {
            metadata: {
              mode: workflow,
              directCostMicrousd: 11n,
            },
            thumbnail: {
              mode: workflow === "AI_ASSISTED" ? "AI_ASSISTED" : "MANUAL",
              directCostMicrousd: workflow === "AI_ASSISTED" ? 13n : 0n,
            },
          },
        });
        expect(
          review?.components.metadata.citations.map(({ id }) => id),
        ).toEqual([assisted.citationIds[1], assisted.citationIds[0]]);
        const publicReview = JSON.stringify(review, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        );
        expect(publicReview).not.toContain("private excerpt");
        expect(publicReview).not.toContain("objectKey");
        if (!review?.candidateFingerprint)
          throw new Error("assisted review was not built");
        const idempotencyKey = randomUUID();
        const input = {
          approvalId: randomUUID(),
          operationRequestId: randomUUID(),
          renderId: candidate.renderId,
          editorialRevision: 1,
          candidateFingerprint: review.candidateFingerprint,
          approvalContractVersion: "human-horizontal-approval-v2" as const,
          attention: {
            schemaVersion: "operator-attention-v2" as const,
            preparationForegroundMs: 800,
            finalReviewForegroundMs: 1_200,
          },
          idempotencyKey,
        };
        const created = await repository.create(input);
        const replay = await repository.create({
          ...input,
          approvalId: randomUUID(),
          operationRequestId: randomUUID(),
        });
        expect(replay.id).toBe(created.id);
        expect(created.state).toBe("CURRENT");
        expect(created.economicsV2).toMatchObject({
          workflowMode: workflow,
          attention: {
            preparationForegroundMs: 800,
            finalReviewForegroundMs: 1_200,
            totalOperatorAttentionMs: 2_000,
          },
          metadataDirectCostMicrousd: 11n,
          thumbnailDirectCostMicrousd: workflow === "AI_ASSISTED" ? 13n : 0n,
        });
      },
    );

    it("rejects a signed citation before public review or v2 approval persistence", async () => {
      const candidate = await readyApprovalCandidate();
      const assisted = await addAssistedProvenance(candidate, "MIXED");
      const secret = "must-not-escape-approval-boundary";
      await prisma.researchCitation.update({
        where: { id: assisted.citationIds[0]! },
        data: {
          url: `https://example.com/private?X-Amz-Signature=${secret}&X-Amz-Expires=60`,
        },
      });
      const repository = new PrismaEditorialApprovalRepository(prisma, true);
      const review = await repository.getReview(candidate.cut.jobId);
      expect(review).toMatchObject({
        approvable: false,
        components: {
          metadata: {
            citations: [],
            incompleteReasons: expect.arrayContaining([
              "CITATIONS_INVALID",
              "CITATION_LINEAGE_INVALID",
            ]),
          },
        },
      });
      const publicReview = JSON.stringify(review, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      expect(publicReview).not.toContain(secret);
      let rejection: unknown;
      try {
        await repository.create({
          approvalId: randomUUID(),
          operationRequestId: randomUUID(),
          renderId: candidate.renderId,
          editorialRevision: 1,
          candidateFingerprint: "a".repeat(64),
          approvalContractVersion: "human-horizontal-approval-v2",
          attention: {
            schemaVersion: "operator-attention-v2",
            preparationForegroundMs: 1,
            finalReviewForegroundMs: 1,
          },
          idempotencyKey: randomUUID(),
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(EditorialApprovalCandidateConflictError);
      expect(String(rejection)).not.toContain(secret);
      expect(
        await prisma.editorialApproval.count({
          where: { editorialPackageId: candidate.editorialPackageId },
        }),
      ).toBe(0);
    });

    it("preserves admitted citation bounds and rejects rows beyond them", async () => {
      const candidate = await readyApprovalCandidate();
      const assisted = await addAssistedProvenance(candidate, "MIXED");
      await prisma.researchCitation.updateMany({
        where: { id: { in: assisted.citationIds.slice(0, 2) } },
        data: { title: "t".repeat(500), publisher: "p".repeat(300) },
      });
      const repository = new PrismaEditorialApprovalRepository(prisma, true);
      const review = await repository.getReview(candidate.cut.jobId);
      expect(review?.approvable).toBe(true);
      if (!review?.candidateFingerprint)
        throw new Error("boundary review was not built");
      const approval = await repository.create({
        approvalId: randomUUID(),
        operationRequestId: randomUUID(),
        renderId: candidate.renderId,
        editorialRevision: 1,
        candidateFingerprint: review.candidateFingerprint,
        approvalContractVersion: "human-horizontal-approval-v2",
        attention: {
          schemaVersion: "operator-attention-v2",
          preparationForegroundMs: 1,
          finalReviewForegroundMs: 1,
        },
        idempotencyKey: randomUUID(),
      });
      await expect(
        new PrismaEditorialExportRepository(prisma).create({
          intentId: randomUUID(),
          operationRequestId: randomUUID(),
          jobId: randomUUID(),
          attemptId: randomUUID(),
          approvalId: approval.id,
          idempotencyKey: randomUUID(),
        }),
      ).resolves.toMatchObject({ view: { approvalId: approval.id } });
      const metadataSnapshot =
        await prisma.editorialApprovalComponentSnapshot.findUniqueOrThrow({
          where: {
            approvalId_component: {
              approvalId: approval.id,
              component: "METADATA",
            },
          },
        });
      const originalCitations = metadataSnapshot.citations;
      if (!Array.isArray(originalCitations)) {
        throw new Error("EXPECTED_METADATA_CITATIONS_ARRAY");
      }
      const originalCitationInput =
        originalCitations as Prisma.InputJsonArray;
      const shiftedCitations = originalCitations.map((citation, index) =>
        index === 0
          ? {
              ...(citation as Record<string, unknown>),
              accessedAt: new Date(
                new Date(
                  String((citation as Record<string, unknown>).accessedAt),
                ).getTime() + 1_000,
              ).toISOString(),
            }
          : citation,
      );
      await prisma.editorialApprovalComponentSnapshot.update({
        where: {
          approvalId_component: {
            approvalId: approval.id,
            component: "METADATA",
          },
        },
        data: { citations: shiftedCitations as Prisma.InputJsonValue },
      });
      await expect(
        new PrismaEditorialExportRepository(prisma).create({
          intentId: randomUUID(),
          operationRequestId: randomUUID(),
          jobId: randomUUID(),
          attemptId: randomUUID(),
          approvalId: approval.id,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(EditorialExportApprovalStaleError);
      await prisma.editorialApprovalComponentSnapshot.update({
        where: {
          approvalId_component: {
            approvalId: approval.id,
            component: "METADATA",
          },
        },
        data: { citations: originalCitationInput },
      });
      const secret = "must-not-escape-api-export-citation";
      await tamperApprovalSnapshotCitation(approval.id, secret);
      let staleRejection: unknown;
      try {
        await new PrismaEditorialExportRepository(prisma).create({
          intentId: randomUUID(),
          operationRequestId: randomUUID(),
          jobId: randomUUID(),
          attemptId: randomUUID(),
          approvalId: approval.id,
          idempotencyKey: randomUUID(),
        });
      } catch (error) {
        staleRejection = error;
      }
      expect(staleRejection).toBeInstanceOf(EditorialExportApprovalStaleError);
      expect(String(staleRejection)).not.toContain(secret);

      const invalidCandidate = await readyApprovalCandidate();
      const invalid = await addAssistedProvenance(invalidCandidate, "MIXED");
      await prisma.researchCitation.update({
        where: { id: invalid.citationIds[1]! },
        data: { title: "t".repeat(501) },
      });
      const invalidReview = await repository.getReview(
        invalidCandidate.cut.jobId,
      );
      expect(invalidReview).toMatchObject({
        approvable: false,
        components: {
          metadata: {
            citations: [],
            incompleteReasons: expect.arrayContaining(["CITATIONS_INVALID"]),
          },
        },
      });
    });

    it("fails closed on private thumbnail safety data without exposing it", async () => {
      const secret = "must-not-escape-thumbnail-safety";
      const candidate = await readyApprovalCandidate();
      await addAssistedProvenance(candidate, "AI_ASSISTED");
      const thumbnailProvenance =
        await prisma.editorialComponentProvenance.findFirstOrThrow({
          where: {
            packageRevisionId: candidate.editorialRevisionId,
            component: "THUMBNAIL",
          },
        });
      await prisma.imageSuggestionCandidate.update({
        where: { id: thumbnailProvenance.imageCandidateId! },
        data: {
          safetyDecision: { credentials: secret, prompt: "private prompt" },
        },
      });
      const repository = new PrismaEditorialApprovalRepository(prisma, true);
      const review = await repository.getReview(candidate.cut.jobId);
      expect(review).toMatchObject({
        approvable: false,
        components: {
          thumbnail: {
            imageSafetyDecision: null,
            incompleteReasons: expect.arrayContaining([
              "THUMBNAIL_LINEAGE_INVALID",
            ]),
          },
        },
      });
      const publicReview = JSON.stringify(review, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      expect(publicReview).not.toContain(secret);
      expect(publicReview).not.toContain("private prompt");
      await expect(
        repository.create({
          approvalId: randomUUID(),
          operationRequestId: randomUUID(),
          renderId: candidate.renderId,
          editorialRevision: 1,
          candidateFingerprint: "a".repeat(64),
          approvalContractVersion: "human-horizontal-approval-v2",
          attention: {
            schemaVersion: "operator-attention-v2",
            preparationForegroundMs: 1,
            finalReviewForegroundMs: 1,
          },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(EditorialApprovalCandidateConflictError);

      const historical = await readyApprovalCandidate();
      await addAssistedProvenance(historical, "AI_ASSISTED");
      const historicalReview = await repository.getReview(historical.cut.jobId);
      if (!historicalReview?.candidateFingerprint)
        throw new Error("assisted review was not built");
      const approval = await repository.create({
        approvalId: randomUUID(),
        operationRequestId: randomUUID(),
        renderId: historical.renderId,
        editorialRevision: 1,
        candidateFingerprint: historicalReview.candidateFingerprint,
        approvalContractVersion: "human-horizontal-approval-v2",
        attention: {
          schemaVersion: "operator-attention-v2",
          preparationForegroundMs: 1,
          finalReviewForegroundMs: 1,
        },
        idempotencyKey: randomUUID(),
      });
      await prisma.$transaction([
        prisma.editorialApprovalComponentSnapshot.update({
          where: {
            approvalId_component: {
              approvalId: approval.id,
              component: "THUMBNAIL",
            },
          },
          data: {
            imageSafetyDecision: {
              credentials: secret,
              prompt: "private prompt",
            },
            likeness: `secret-likeness-${secret}`,
            incompleteReasons: [`secret-component-${secret}`],
          },
        }),
        prisma.editorialApprovalEconomicsV2.update({
          where: { approvalId: approval.id },
          data: { incompleteReasons: [`secret-economics-${secret}`] },
        }),
        prisma.editorialApprovalMetrics.update({
          where: { approvalId: approval.id },
          data: { incompleteReasons: [`secret-metrics-${secret}`] },
        }),
      ]);
      const reloaded = await repository.getReview(historical.cut.jobId);
      const publicReload = JSON.stringify(reloaded, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      expect(reloaded?.currentApproval).toBeNull();
      expect(reloaded?.latestApproval).toMatchObject({ state: "STALE" });
      expect(publicReload).not.toContain(secret);
      expect(publicReload).not.toContain("private prompt");
      await expect(
        new PrismaEditorialExportRepository(prisma).create({
          intentId: randomUUID(),
          operationRequestId: randomUUID(),
          jobId: randomUUID(),
          attemptId: randomUUID(),
          approvalId: approval.id,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(EditorialExportApprovalStaleError);
    });

    it("terminalizes a queued export whose exact processing template snapshot changed", async () => {
      const prepared = await readyApprovedExport();
      const templateRevision =
        await prisma.processingTemplateRevision.findUniqueOrThrow({
          where: { id: prepared.approval.body.processingTemplateRevisionId },
        });
      const replacement = await prisma.processingTemplateRevision.create({
        data: {
          id: randomUUID(),
          templateId: templateRevision.templateId,
          revision: templateRevision.revision + 1,
          name: "Changed processing template",
        },
      });
      await prisma.editorialPackageRevision.update({
        where: { id: prepared.approval.body.editorialPackageRevisionId },
        data: { processingTemplateRevisionId: replacement.id },
      });

      await request(app.getHttpServer())
        .get(`/api/v1/editorial-exports/${prepared.export.body.id}`)
        .expect(200)
        .expect(({ body }) => expect(body.approvalCurrent).toBe(false));
      const writesBefore = {
        intents: await prisma.editorialExportIntent.count(),
        operations: await prisma.editorialOperationRequest.count(),
        jobs: await prisma.pipelineJob.count({
          where: { type: "EXPORT_EDITORIAL_PACKAGE" },
        }),
      };
      await request(app.getHttpServer())
        .post(
          `/api/v1/editorial-approvals/${prepared.approval.body.id}/exports`,
        )
        .set("Idempotency-Key", randomUUID())
        .expect(409)
        .expect(({ body }) =>
          expect(body.error.code).toBe("EDITORIAL_APPROVAL_STALE"),
        );
      await expect(
        new PrismaPipelineRepository(prisma).getRunnableJobsByIds([
          prepared.export.body.job.id as string,
        ]),
      ).resolves.toEqual([]);
      await expect(
        prisma.pipelineJob.findUniqueOrThrow({
          where: { id: prepared.export.body.job.id as string },
          select: { state: true, failureCode: true, failureRetryable: true },
        }),
      ).resolves.toEqual({
        state: "FAILED_FINAL",
        failureCode: "EXPORT_APPROVAL_STALE",
        failureRetryable: false,
      });
      await expect(
        prisma.jobAttempt.findFirstOrThrow({
          where: { jobId: prepared.export.body.job.id as string },
          select: { state: true, failureCode: true },
        }),
      ).resolves.toEqual({
        state: "FAILED_FINAL",
        failureCode: "EXPORT_APPROVAL_STALE",
      });
      await expect(
        Promise.all([
          prisma.editorialExportIntent.count(),
          prisma.editorialOperationRequest.count(),
          prisma.pipelineJob.count({
            where: { type: "EXPORT_EDITORIAL_PACKAGE" },
          }),
        ]),
      ).resolves.toEqual([
        writesBefore.intents,
        writesBefore.operations,
        writesBefore.jobs,
      ]);
    });

    it("classifies an expired export lease with a stale approval as terminal", async () => {
      const prepared = await readyApprovedExport();
      const expiredAt = new Date(Date.now() - 60_000);
      const leaseToken = randomUUID();
      await prisma.pipelineJob.update({
        where: { id: prepared.export.body.job.id as string },
        data: {
          state: "PROCESSING",
          attemptCount: 1,
          leaseOwner: "killed-worker",
          leaseToken,
          leaseExpiresAt: expiredAt,
          heartbeatAt: expiredAt,
        },
      });
      await prisma.jobAttempt.updateMany({
        where: {
          jobId: prepared.export.body.job.id as string,
          attemptNumber: 1,
        },
        data: {
          state: "PROCESSING",
          workerId: "killed-worker",
          leaseToken,
          startedAt: expiredAt,
          heartbeatAt: expiredAt,
        },
      });
      await prisma.editorialPackage.update({
        where: { id: prepared.candidate.editorialPackageId },
        data: { currentRevision: 2 },
      });

      await expect(
        new PrismaPipelineRepository(prisma).recoverExpiredLeases(10),
      ).resolves.toEqual([]);
      await expect(
        prisma.pipelineJob.findUniqueOrThrow({
          where: { id: prepared.export.body.job.id as string },
          select: {
            state: true,
            failureCode: true,
            failureRetryable: true,
            leaseToken: true,
          },
        }),
      ).resolves.toEqual({
        state: "FAILED_FINAL",
        failureCode: "EXPORT_APPROVAL_STALE",
        failureRetryable: false,
        leaseToken: null,
      });
    });

    async function readyApprovedExport() {
      const candidate = await readyApprovalCandidate();
      const review = await request(app.getHttpServer())
        .get(`/api/v1/pipeline-jobs/${candidate.cut.jobId}/editorial-review`)
        .expect(200);
      const approval = await request(app.getHttpServer())
        .post(
          `/api/v1/assembly-renders/${candidate.renderId}/editorial-approvals`,
        )
        .set("Idempotency-Key", randomUUID())
        .send({
          editorialRevision: 1,
          candidateFingerprint: review.body.candidateFingerprint,
          manualAttentionMs: 1_000,
          attentionMeasurementVersion: "foreground-preview-v1",
        })
        .expect(201);
      const exportResponse = await request(app.getHttpServer())
        .post(`/api/v1/editorial-approvals/${approval.body.id}/exports`)
        .set("Idempotency-Key", randomUUID())
        .expect(202);
      return { candidate, approval, export: exportResponse };
    }

    async function readyApprovalCandidate(input?: {
      withBanner?: boolean;
      existingSource?: { projectId: string; sourceId: string };
    }) {
      const cut = await readyCut(input?.existingSource);
      const bannerId = input?.withBanner
        ? await readyAsset(cut, "BANNER")
        : undefined;
      const recipeResponse = await request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-recipe`)
        .set("Idempotency-Key", randomUUID())
        .send(fullRequest({ banners: bannerId ? [bannerId] : [] }))
        .expect(200);
      const renderResponse = await request(app.getHttpServer())
        .post(`/api/v1/pipeline-jobs/${cut.jobId}/assembly-renders`)
        .set("Idempotency-Key", randomUUID())
        .send({ recipeRevision: 1 })
        .expect(202);
      const assemblyJobId = renderResponse.body.job.id as string;
      const assemblyQueuedAt = new Date("2026-01-01T00:00:00.000Z");
      await prisma.pipelineJob.update({
        where: { id: assemblyJobId },
        data: {
          state: "READY",
          attemptCount: 2,
          queuedAt: assemblyQueuedAt,
          startedAt: new Date("2026-01-01T00:00:10.000Z"),
          finishedAt: new Date("2026-01-01T00:01:50.000Z"),
        },
      });
      const firstAttempt = await prisma.jobAttempt.findFirstOrThrow({
        where: { jobId: assemblyJobId, attemptNumber: 1 },
      });
      await prisma.jobAttempt.update({
        where: { id: firstAttempt.id },
        data: {
          state: "FAILED_RETRYABLE",
          startedAt: new Date("2026-01-01T00:00:10.000Z"),
          finishedAt: new Date("2026-01-01T00:00:40.000Z"),
        },
      });
      await prisma.jobAttempt.create({
        data: {
          id: randomUUID(),
          jobId: assemblyJobId,
          attemptNumber: 2,
          state: "READY",
          startedAt: new Date("2026-01-01T00:01:00.000Z"),
          finishedAt: new Date("2026-01-01T00:01:50.000Z"),
        },
      });
      const artifactId = randomUUID();
      const resultId = randomUUID();
      await prisma.mediaArtifact.create({
        data: {
          id: artifactId,
          projectId: cut.projectId,
          sourceId: cut.sourceId,
          role: "HORIZONTAL_ASSEMBLY_RESULT",
          status: "READY",
          objectKey: `test/approval/${artifactId}.mp4`,
          sizeBytes: 700n,
          sha256: "f".repeat(64),
          contentType: "video/mp4",
          lineageSourceId: cut.sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "horizontal-render-v1",
          pipelineJobId: assemblyJobId,
          outputFilename: "assembled.mp4",
        },
      });
      await prisma.assemblyRenderResult.create({
        data: {
          id: resultId,
          renderIntentId: renderResponse.body.id as string,
          artifactId,
          durationMs: 120_000,
          width: 1280,
          height: 720,
          fpsNumerator: 25,
          fpsDenominator: 1,
          videoCodec: "h264",
          pixelFormat: "yuv420p",
          audioCodec: "aac",
          audioSampleRate: 48_000,
          audioChannels: 2,
          ffmpegVersion: "ffmpeg-test",
          ffprobeVersion: "ffprobe-test",
          integratedLoudnessLufs: -14,
          truePeakDbtp: -1.5,
          normalizationProfileResult: "PASS",
          completedAt: new Date("2026-01-01T00:01:50.000Z"),
        },
      });
      const thumbnailId = randomUUID();
      await prisma.editorialAsset.create({
        data: {
          id: thumbnailId,
          projectId: cut.projectId,
          type: "THUMBNAIL",
          status: "READY",
          idempotencyKey: randomUUID(),
          requestFingerprint: "thumbnail-test",
          objectKey: `test/editorial/${thumbnailId}.png`,
          originalFilename: "обложка.png",
          contentType: "image/png",
          sizeBytes: 300n,
          sha256: "d".repeat(64),
          width: 1280,
          height: 720,
        },
      });
      const template = await prisma.processingTemplate.create({
        data: {
          id: randomUUID(),
          idempotencyKey: randomUUID(),
          requestFingerprint: "template-test",
          revisions: {
            create: {
              id: randomUUID(),
              revision: 1,
              name: "Тестовый шаблон",
            },
          },
        },
        include: { revisions: true },
      });
      const editorialPackageId = randomUUID();
      const editorialRevisionId = randomUUID();
      await prisma.editorialPackage.create({
        data: {
          id: editorialPackageId,
          projectId: cut.projectId,
          pipelineJobId: cut.jobId,
          cutResultArtifactId: cut.artifactId,
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: 500n,
          cutResultRecipeVersion: "stage1-cut-h264-v2",
          lineageSourceId: cut.sourceId,
          lineageSourceVersion: 1,
          currentRevision: 1,
          revisions: {
            create: {
              id: editorialRevisionId,
              revision: 1,
              processingTemplateRevisionId: template.revisions[0]!.id,
              title: "Тестовый заголовок",
              description: "Тестовое описание",
              tags: ["первый", "второй"],
              thumbnailAssetId: thumbnailId,
            },
          },
        },
      });
      return {
        cut,
        bannerId,
        recipeId: recipeResponse.body.id as string,
        editorialPackageId,
        editorialRevisionId,
        thumbnailId,
        renderId: renderResponse.body.id as string,
        resultId,
        assemblyJobId,
      };
    }

    async function addAssistedProvenance(
      candidate: Awaited<ReturnType<typeof readyApprovalCandidate>>,
      workflow: "MIXED" | "AI_ASSISTED",
    ) {
      const source = await prisma.videoSource.findUniqueOrThrow({
        where: { id: candidate.cut.sourceId },
        include: { authorizations: true },
      });
      const cut = await prisma.pipelineJob.findUniqueOrThrow({
        where: { id: candidate.cut.jobId },
        include: { segment: true, resultArtifact: true },
      });
      const thumbnail = await prisma.editorialAsset.findUniqueOrThrow({
        where: { id: candidate.thumbnailId },
      });
      const authorization = source.authorizations[0]!;
      const now = new Date(Date.now() - 60_000);
      const later = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
      const profileId = randomUUID();
      const profileRevisionId = randomUUID();
      const identityId = randomUUID();
      const contextId = randomUUID();
      const contextRevisionId = randomUUID();
      const promptId = randomUUID();
      const promptRevisionId = randomUUID();
      await prisma.creatorProfile.create({ data: { id: profileId } });
      await prisma.creatorProfileOfficialUrlIdentity.create({
        data: {
          id: identityId,
          creatorProfileId: profileId,
          canonicalUrl: `https://example.test/creator/${profileId}`,
        },
      });
      await prisma.creatorProfileRevision.create({
        data: {
          id: profileRevisionId,
          creatorProfileId: profileId,
          revision: 1,
          canonicalDisplayName: "Integrated review fixture",
          officialUrlIdentityId: identityId,
          officialUrl: `https://example.test/creator/${profileId}`,
          primaryLanguage: "ru",
          topics: [],
          editorialNotes: "",
          restrictions: [],
        },
      });
      await prisma.sourceEditorialContext.create({
        data: {
          id: contextId,
          projectId: candidate.cut.projectId,
          sourceId: candidate.cut.sourceId,
          sourceVersion: 1,
        },
      });
      await prisma.sourceEditorialContextRevision.create({
        data: {
          id: contextRevisionId,
          contextId,
          revision: 1,
          projectId: candidate.cut.projectId,
          sourceId: candidate.cut.sourceId,
          sourceVersion: 1,
          creatorProfileId: profileId,
          creatorProfileRevisionId: profileRevisionId,
          creatorProfileRevisionNo: 1,
          sourceTitle: "Integrated fixture",
          gameOrTopic: "fixture",
          audience: "fixture",
          editorialGoal: "fixture",
          language: "ru",
          defaultCta: "",
          restrictions: [],
          operatorNotes: "",
        },
      });
      await prisma.cutEditorialPrompt.create({
        data: {
          id: promptId,
          cutPipelineJobId: cut.id,
          projectId: cut.projectId,
          sourceId: cut.sourceId,
          sourceVersion: cut.sourceVersion,
          cutResultArtifactId: cut.resultArtifact!.id,
          cutResultSha256: cut.resultArtifact!.sha256,
          cutResultSizeBytes: cut.resultArtifact!.sizeBytes,
        },
      });
      await prisma.cutEditorialPromptRevision.create({
        data: {
          id: promptRevisionId,
          promptId,
          revision: 1,
          projectId: cut.projectId,
          sourceId: cut.sourceId,
          sourceVersion: cut.sourceVersion,
          sourceContextId: contextId,
          sourceContextRevisionId: contextRevisionId,
          sourceContextRevisionNo: 1,
          whatHappens: "fixture",
          desiredAngle: "fixture",
          tone: "fixture",
          cta: "",
          restrictions: [],
        },
      });
      const transcriptIntentId = randomUUID();
      const transcriptArtifactId = randomUUID();
      const transcriptSha256 = "1".repeat(64);
      await prisma.transcriptEvidenceIntent.create({
        data: {
          id: transcriptIntentId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "2".repeat(64),
          projectId: cut.projectId,
          sourceId: cut.sourceId,
          sourceVersion: cut.sourceVersion,
          sourceSha256: source.sha256,
          sourceAuthorizationRevision: authorization.revision,
          sourceAuthorizationBasis: authorization.basis,
          sourceAuthorizationDeclarationVersion:
            authorization.declarationVersion,
          sourceAuthorizationDecidedAt: authorization.decidedAt,
          cutPipelineJobId: cut.id,
          cutResultArtifactId: cut.resultArtifact!.id,
          cutResultSha256: cut.resultArtifact!.sha256,
          cutResultSizeBytes: cut.resultArtifact!.sizeBytes,
          cutStartMs: cut.segment!.startMs,
          cutEndMs: cut.segment!.endMs,
          creatorProfileRevisionId: profileRevisionId,
          creatorProfileId: profileId,
          creatorProfileRevisionNo: 1,
          sourceContextRevisionId: contextRevisionId,
          sourceContextId: contextId,
          sourceContextRevisionNo: 1,
          cutPromptRevisionId: promptRevisionId,
          cutPromptId: promptId,
          cutPromptRevisionNo: 1,
          contractVersion: "transcript-evidence-v1",
          adapterVersion: "local-deterministic-transcript-v1",
          language: "ru",
          fixture: {},
          state: "READY",
          attemptCount: 1,
          startedAt: now,
          finishedAt: now,
          artifact: {
            create: {
              id: transcriptArtifactId,
              objectKey: `ai-content/transcripts/${transcriptIntentId}/transcript.json`,
              contentType: "application/json",
              sizeBytes: 64n,
              sha256: transcriptSha256,
              adapterVersion: "local-deterministic-transcript-v1",
              language: "ru",
              segments: [],
            },
          },
        },
      });
      const researchIntentId = randomUUID();
      const citationIds = [randomUUID(), randomUUID(), randomUUID()];
      await prisma.researchSuggestionIntent.create({
        data: {
          id: researchIntentId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "3".repeat(64),
          transcriptIntentId,
          projectId: cut.projectId,
          sourceId: cut.sourceId,
          sourceVersion: cut.sourceVersion,
          cutPipelineJobId: cut.id,
          cutResultArtifactId: cut.resultArtifact!.id,
          creatorProfileRevisionId: profileRevisionId,
          sourceContextRevisionId: contextRevisionId,
          cutPromptRevisionId: promptRevisionId,
          contextPolicyFingerprint: "4".repeat(64),
          transcriptArtifactId,
          transcriptSha256,
          query: "fixture",
          contractVersion: "research-suggestion-v1",
          adapterVersion: "local-deterministic-research-v1",
          freshnessPolicyVersion: "research-freshness-v1",
          searchedAt: now,
          freshUntil: later,
          state: "READY",
          citations: {
            create: citationIds.map((id, ordinal) => ({
              id,
              ordinal,
              url: `https://example.com/citation/${ordinal}`,
              title: `Citation ${ordinal}`,
              publisher: "Example",
              accessedAt: now,
              excerpt: "private excerpt",
              checksum: "5".repeat(64),
            })),
          },
        },
      });
      const researchAttemptId = randomUUID();
      await prisma.researchSuggestionAttempt.create({
        data: {
          id: researchAttemptId,
          intentId: researchIntentId,
          attemptNumber: 1,
          state: "READY",
          leaseToken: randomUUID(),
          leaseExpiresAt: later,
          workDeadlineAt: later,
        },
      });
      const suggestionSetId = randomUUID();
      await prisma.researchSuggestionSet.create({
        data: {
          id: suggestionSetId,
          intentId: researchIntentId,
          attemptId: researchAttemptId,
          title: "Suggested title",
          description: "Suggested description",
          tags: ["suggested"],
          claims: [],
          citationIds: [citationIds[1]!, citationIds[0]!],
          basisVersion: "research-suggestion-v1",
          directCostMicrousd: 11n,
          costBasisVersion: "local-direct-ai-cost-v1",
        },
      });
      let imageIntentId: string | null = null;
      let imageCandidateId: string | null = null;
      if (workflow === "AI_ASSISTED") {
        imageIntentId = randomUUID();
        const imageAttemptId = randomUUID();
        imageCandidateId = randomUUID();
        await prisma.imageSuggestionIntent.create({
          data: {
            id: imageIntentId,
            idempotencyKey: randomUUID(),
            requestFingerprint: "6".repeat(64),
            projectId: cut.projectId,
            sourceId: cut.sourceId,
            sourceVersion: cut.sourceVersion,
            sourceSha256: source.sha256,
            sourceAuthorizationRevision: authorization.revision,
            sourceAuthorizationBasis: authorization.basis!,
            sourceAuthorizationDeclarationVersion:
              authorization.declarationVersion!,
            sourceAuthorizationDecidedAt: authorization.decidedAt!,
            cutPipelineJobId: cut.id,
            cutResultArtifactId: cut.resultArtifact!.id,
            cutResultSha256: cut.resultArtifact!.sha256,
            cutResultSizeBytes: cut.resultArtifact!.sizeBytes,
            cutStartMs: cut.segment!.startMs,
            cutEndMs: cut.segment!.endMs,
            creatorProfileId: profileId,
            creatorProfileRevisionId: profileRevisionId,
            creatorProfileRevisionNo: 1,
            sourceContextId: contextId,
            sourceContextRevisionId: contextRevisionId,
            sourceContextRevisionNo: 1,
            cutPromptId: promptId,
            cutPromptRevisionId: promptRevisionId,
            cutPromptRevisionNo: 1,
            contextPolicyFingerprint: "4".repeat(64),
            contractVersion: "image-suggestion-v1",
            adapterVersion: "local-no-likeness-png-v1",
            promptBasisVersion: "local-abstract-thumbnail-prompt-v1",
            state: "READY",
          },
        });
        await prisma.imageSuggestionAttempt.create({
          data: {
            id: imageAttemptId,
            intentId: imageIntentId,
            attemptNumber: 1,
            state: "READY",
            leaseToken: randomUUID(),
            leaseExpiresAt: later,
            workDeadlineAt: later,
            objectKey: thumbnail.objectKey,
            uploadStartedAt: now,
            uploadSettledAt: now,
            cleanupStatus: "NOT_REQUIRED",
          },
        });
        await prisma.imageSuggestionCandidate.create({
          data: {
            id: imageCandidateId,
            intentId: imageIntentId,
            attemptId: imageAttemptId,
            objectKey: thumbnail.objectKey,
            contentType: thumbnail.contentType,
            sizeBytes: thumbnail.sizeBytes,
            sha256: thumbnail.sha256,
            width: thumbnail.width!,
            height: thumbnail.height!,
            contractVersion: "editorial-thumbnail-v1",
            adapterVersion: "local-no-likeness-png-v1",
            promptBasisVersion: "local-abstract-thumbnail-prompt-v1",
            likeness: "NONE",
            safetyDecision: {
              version: "no-likeness-safety-v1",
              realisticPersonRequested: false,
              referenceImageUsed: false,
              externalProviderUsed: false,
            },
            directCostMicrousd: 13n,
            costBasisVersion: "local-direct-ai-cost-v1",
          },
        });
      }
      await prisma.editorialComponentProvenance.createMany({
        data: [
          {
            id: randomUUID(),
            packageRevisionId: candidate.editorialRevisionId,
            component: "METADATA",
            mode: workflow,
            basisVersion: "research-suggestion-v1",
            researchIntentId,
            suggestionSetId,
          },
          {
            id: randomUUID(),
            packageRevisionId: candidate.editorialRevisionId,
            component: "THUMBNAIL",
            mode: workflow === "AI_ASSISTED" ? "AI_ASSISTED" : "MANUAL",
            basisVersion:
              workflow === "AI_ASSISTED"
                ? "image-suggestion-v1"
                : "manual-editorial-v1",
            imageIntentId,
            imageCandidateId,
          },
        ],
      });
      return { citationIds };
    }

    async function tamperApprovalSnapshotCitation(
      approvalId: string,
      secret: string,
    ): Promise<void> {
      const [snapshots, economics] = await Promise.all([
        prisma.editorialApprovalComponentSnapshot.findMany({
          where: { approvalId },
        }),
        prisma.editorialApprovalEconomicsV2.findUniqueOrThrow({
          where: { approvalId },
        }),
      ]);
      const metadata = snapshots.find((row) => row.component === "METADATA")!;
      const thumbnail = snapshots.find((row) => row.component === "THUMBNAIL")!;
      const citations = (
        metadata.citations as Array<Record<string, unknown>>
      ).map((citation, index) =>
        index === 0
          ? { ...citation, credentials: secret, excerpt: "private excerpt" }
          : citation,
      );
      const fingerprintCitations = citations.map((citation) => ({
        ...citation,
        publishedAt:
          typeof citation.publishedAt === "string"
            ? new Date(citation.publishedAt)
            : null,
        accessedAt: new Date(String(citation.accessedAt)),
      }));
      const rawFreshness = metadata.freshness as Record<string, unknown>;
      const fingerprintFreshness = {
        ...rawFreshness,
        searchedAt: new Date(String(rawFreshness.searchedAt)),
        freshUntil: new Date(String(rawFreshness.freshUntil)),
      };
      const metadataFingerprint = createHash("sha256")
        .update(
          [
            "editorial-approval-component-snapshot-v2",
            metadata.component,
            metadata.provenanceId,
            metadata.mode,
            metadata.basisVersion,
            metadata.researchIntentId ?? "",
            metadata.suggestionSetId ?? "",
            metadata.imageIntentId ?? "",
            metadata.imageCandidateId ?? "",
            metadata.transcriptArtifactId ?? "",
            metadata.transcriptSha256 ?? "",
            canonicalTestJson(fingerprintCitations),
            canonicalTestJson(fingerprintFreshness),
            "null",
            metadata.likeness ?? "",
            metadata.directCostMicrousd.toString(),
            metadata.costBasisVersion,
            canonicalTestJson(metadata.incompleteReasons),
          ].join("\n"),
        )
        .digest("hex");
      const economicsFingerprint = createHash("sha256")
        .update(
          [
            "approval-economics-v2",
            economics.workflowMode,
            economics.preparationForegroundMs.toString(),
            economics.finalReviewForegroundMs.toString(),
            metadataFingerprint,
            thumbnail.snapshotFingerprint,
            economics.metadataDirectCostMicrousd.toString(),
            economics.evidenceDirectCostMicrousd.toString(),
            economics.thumbnailDirectCostMicrousd.toString(),
            economics.combinedDirectCostMicrousd.toString(),
          ].join("\n"),
        )
        .digest("hex");
      await prisma.$transaction([
        prisma.editorialApprovalComponentSnapshot.update({
          where: {
            approvalId_component: { approvalId, component: "METADATA" },
          },
          data: {
            citations: citations as Prisma.InputJsonValue,
            snapshotFingerprint: metadataFingerprint,
          },
        }),
        prisma.editorialApprovalEconomicsV2.update({
          where: { approvalId },
          data: { snapshotFingerprint: economicsFingerprint },
        }),
      ]);
    }

    function canonicalTestJson(value: unknown): string {
      if (value === undefined) return "null";
      if (value === null || typeof value !== "object")
        return JSON.stringify(value);
      if (Array.isArray(value))
        return `[${value.map(canonicalTestJson).join(",")}]`;
      const row = value as Record<string, unknown>;
      return `{${Object.keys(row)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalTestJson(row[key])}`)
        .join(",")}}`;
    }

    async function readyCut(existingSource?: {
      projectId: string;
      sourceId: string;
    }): Promise<{
      projectId: string;
      sourceId: string;
      jobId: string;
      artifactId: string;
    }> {
      const projectId = existingSource?.projectId ?? randomUUID();
      const sourceId = existingSource?.sourceId ?? randomUUID();
      const jobId = randomUUID();
      const artifactId = randomUUID();
      if (!existingSource) {
        await prisma.project.create({
          data: {
            id: projectId,
            idempotencyKey: randomUUID(),
            requestFingerprint: "recipe-test",
            name: "Assembly recipe test",
            status: "SOURCE_READY",
            source: {
              create: {
                id: sourceId,
                status: "READY",
                originalFilename: "source.mp4",
                contentType: "video/mp4",
                sizeBytes: 1_000n,
                sha256: "a".repeat(64),
                durationMs: 300_000,
                authorizations: {
                  create: {
                    sourceVersion: 1,
                    status: "CLEARED",
                    basis: "OPERATOR_ATTESTATION",
                    declarationVersion: "source-authorization-v1",
                    decidedAt: new Date(),
                  },
                },
              },
            },
          },
        });
      }
      await prisma.pipelineJob.create({
        data: {
          id: jobId,
          projectId,
          sourceId,
          sourceVersion: 1,
          type: "CUT_SEGMENT",
          state: "READY",
          idempotencyKey: randomUUID(),
          recipeVersion: "stage1-cut-h264-v2",
          attemptCount: 2,
          queuedAt: new Date("2026-01-01T00:00:00.000Z"),
          startedAt: new Date("2026-01-01T00:00:10.000Z"),
          finishedAt: new Date("2026-01-01T00:01:50.000Z"),
          attempts: {
            create: [
              {
                id: randomUUID(),
                attemptNumber: 1,
                state: "FAILED_RETRYABLE",
                startedAt: new Date("2026-01-01T00:00:10.000Z"),
                finishedAt: new Date("2026-01-01T00:00:40.000Z"),
              },
              {
                id: randomUUID(),
                attemptNumber: 2,
                state: "READY",
                startedAt: new Date("2026-01-01T00:01:00.000Z"),
                finishedAt: new Date("2026-01-01T00:01:50.000Z"),
              },
            ],
          },
          segment: {
            create: {
              id: randomUUID(),
              clientSegmentId: randomUUID(),
              startMs: 10_000,
              endMs: 130_000,
            },
          },
        },
      });
      await prisma.mediaArtifact.create({
        data: {
          id: artifactId,
          projectId,
          sourceId,
          role: "CUT_RESULT",
          status: "READY",
          objectKey: `test/${artifactId}.mp4`,
          sizeBytes: 500n,
          sha256: "b".repeat(64),
          contentType: "video/mp4",
          lineageSourceId: sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "stage1-cut-h264-v2",
          pipelineJobId: jobId,
        },
      });
      return { projectId, sourceId, jobId, artifactId };
    }

    async function readyAsset(
      cut: { projectId: string; sourceId: string },
      kind: "INTRO" | "OUTRO" | "ADVERTISEMENT" | "BANNER",
      status: "READY" | "PROBE_PENDING" = "READY",
    ): Promise<string> {
      const id = randomUUID();
      await prisma.montageAsset.create({
        data: {
          id,
          projectId: cut.projectId,
          sourceId: cut.sourceId,
          sourceVersion: 1,
          kind,
          status,
          revision: 3,
          idempotencyKey: randomUUID(),
          requestFingerprint: "asset-test",
          objectKey: `test/montage/${id}`,
          originalFilename: kind === "BANNER" ? "banner.png" : "video.mp4",
          contentType: kind === "BANNER" ? "image/png" : "video/mp4",
          sizeBytes: 200n,
          sha256: "c".repeat(64),
          width: 1280,
          height: 720,
          durationMs: kind === "BANNER" ? null : 5_000,
          hasAudio: kind === "BANNER" ? null : true,
          probeVersion: kind === "BANNER" ? null : "test-probe-v1",
          probedAt: kind === "BANNER" ? null : new Date(),
          rightsBasis: "LOCAL_DEVELOPMENT_AUTO",
          rightsDeclaration: "montage-local-development-auto-v1",
          rightsDecidedAt: new Date(),
          uploadExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      return id;
    }

    function fullRequest(input: {
      intro?: string;
      outro?: string;
      advertisement?: string;
      banners?: string[];
    }) {
      return {
        expectedRevision: 0,
        introAssetId: input.intro ?? null,
        outroAssetId: input.outro ?? null,
        advertisement: input.advertisement
          ? { assetId: input.advertisement, insertAtMs: 60_000 }
          : null,
        banners: (input.banners ?? []).map((assetId, index) => ({
          clientItemId: `banner-${index + 1}`,
          assetId,
          startMs: index * 10_000,
          endMs: index * 10_000 + 5_000,
          position: index % 2 === 0 ? "TOP_RIGHT" : "BOTTOM_LEFT",
        })),
        cta: {
          text: "Смотрите стрим на Twitch",
          startMs: 30_000,
          endMs: 45_000,
          position: "BOTTOM_LEFT",
        },
        audioProfileVersion: "youtube-stereo-v1",
        encodingProfileVersion: "youtube-h264-v1",
      };
    }

    async function assertMigrationSchemaMatch(input: {
      datasourceUrl: string;
      shadowDatabaseUrl: string;
      migrations: string;
    }): Promise<void> {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "content-factory-recipe-diff-"),
      );
      const configPath = join(temporaryDirectory, "prisma.config.mjs");
      const schema = resolve(import.meta.dirname, "../prisma/schema.prisma");
      await writeFile(
        configPath,
        `export default ${JSON.stringify({
          schema,
          migrations: { path: input.migrations },
          datasource: {
            url: input.datasourceUrl,
            shadowDatabaseUrl: input.shadowDatabaseUrl,
          },
        })};\n`,
        "utf8",
      );
      try {
        const cli = resolve(
          import.meta.dirname,
          "../node_modules/prisma/build/index.js",
        );
        const child = spawn(
          process.execPath,
          [
            cli,
            "migrate",
            "diff",
            "--from-migrations",
            input.migrations,
            "--to-schema",
            schema,
            "--exit-code",
            "--config",
            configPath,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        const exitCode = await new Promise<number>((resolveExit, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolveExit(code ?? 1));
        });
        if (exitCode !== 0) {
          const marker = output.indexOf("[*] Changed");
          const drift =
            marker >= 0 ? output.slice(marker).trim() : output.trim();
          if (exitCode !== 2 || drift !== KNOWN_PREEXISTING_SCHEMA_DRIFT) {
            throw new Error(`MIGRATION_SCHEMA_DRIFT:${exitCode}:${output}`);
          }
        }
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  },
);

// This allowlist predates Stage 2b. Any AssemblyRecipe drift, new table drift,
// or change to this exact debt snapshot fails the isolated suite.
const KNOWN_PREEXISTING_SCHEMA_DRIFT = `[*] Changed the \`JobAttempt\` table
  [*] Altered column \`updatedAt\` (default changed from \`Some(Now)\` to \`None\`)

[*] Changed the \`MontageAsset\` table
  [-] Removed foreign key on columns (sourceId, projectId)
  [*] Altered column \`updatedAt\` (default changed from \`Some(Now)\` to \`None\`)

[*] Changed the \`PipelineJob\` table
  [-] Removed foreign key on columns (montageAssetId, projectId, sourceId, sourceVersion)
  [*] Altered column \`updatedAt\` (default changed from \`Some(Now)\` to \`None\`)

[*] Changed the \`SourceAuthorization\` table
  [-] Removed foreign key on columns (sourceId)
  [-] Dropped the primary key on columns (sourceId, sourceVersion)
  [*] Altered column \`sourceId\` (type changed)
  [*] Altered column \`updatedAt\` (default changed from \`Some(Now)\` to \`None\`)
  [+] Added primary key on columns (sourceId, sourceVersion)
)
  [+] Added foreign key on columns (sourceId)

[*] Changed the \`VideoSource\` table
  [-] Removed unique index on columns (id, projectId)`;
