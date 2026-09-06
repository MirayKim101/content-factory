import "reflect-metadata";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
} from "../src/editorial-content/application/editorial-approval-repository.port.js";
import { CreateEditorialApproval } from "../src/editorial-content/application/create-editorial-approval.js";
import {
  GetEditorialReview,
  ListEditorialApprovals,
} from "../src/editorial-content/application/editorial-approval-queries.js";
import { PrismaEditorialApprovalRepository } from "../src/editorial-content/infrastructure/prisma-editorial-approval.repository.js";
import { EditorialApprovalController } from "../src/editorial-content/presentation/editorial-approval.controller.js";
import { HttpExceptionFilter } from "../src/http-exception.filter.js";
import { JOB_DISPATCH } from "../src/media-pipeline/application/job-dispatch.port.js";
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
        ],
        providers: [
          { provide: PrismaService, useValue: prisma },
          { provide: JOB_DISPATCH, useValue: dispatch },
          { provide: ASSEMBLY_RENDER_ADMISSION_ENABLED, useValue: true },
          { provide: EDITORIAL_APPROVAL_ADMISSION_ENABLED, useValue: true },
          { provide: OBJECT_STORAGE, useValue: storage },
          PrismaAssemblyRecipeRepository,
          PrismaAssemblyRenderRepository,
          PrismaEditorialApprovalRepository,
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
        ],
      })
      class IsolatedModule {}
      app = await NestFactory.create(IsolatedModule, { logger: false });
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
        projectId: candidate.cut.projectId,
        cutPipelineJobId: candidate.cut.jobId,
        approvable: true,
        blockers: [],
        editorial: { revision: 1, title: "Тестовый заголовок" },
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

      const operationKey = randomUUID();
      await prisma.editorialOperationRequest.create({
        data: {
          id: randomUUID(),
          idempotencyKey: operationKey,
          operation: "CREATE_EDITORIAL_EXPORT",
          canonicalRequestFingerprint: "e".repeat(64),
          resolvedProjectId: first.cut.projectId,
          exportIntentId: randomUUID(),
        },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/assembly-renders/${first.renderId}/editorial-approvals`)
        .set("Idempotency-Key", operationKey)
        .send(body)
        .expect(409)
        .expect(({ body: responseBody }) =>
          expect(responseBody.error.code).toBe("IDEMPOTENCY_CONFLICT"),
        );
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
              id: randomUUID(),
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
        renderId: renderResponse.body.id as string,
        resultId,
        assemblyJobId,
      };
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
