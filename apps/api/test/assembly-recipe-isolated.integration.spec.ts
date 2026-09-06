import "reflect-metadata";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  BadRequestException,
  Module,
  ValidationPipe,
  type INestApplication,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { ASSEMBLY_RECIPE_REPOSITORY } from "../src/editorial-content/application/assembly-recipe-repository.port.js";
import {
  GetAssemblyRecipe,
  GetAssemblyRecipeRevision,
  ListAssemblyRecipes,
} from "../src/editorial-content/application/assembly-recipe-queries.js";
import { SaveAssemblyRecipe } from "../src/editorial-content/application/save-assembly-recipe.js";
import { PrismaAssemblyRecipeRepository } from "../src/editorial-content/infrastructure/prisma-assembly-recipe.repository.js";
import { AssemblyRecipeController } from "../src/editorial-content/presentation/assembly-recipe.controller.js";
import { HttpExceptionFilter } from "../src/http-exception.filter.js";

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
        controllers: [AssemblyRecipeController],
        providers: [
          { provide: PrismaService, useValue: prisma },
          PrismaAssemblyRecipeRepository,
          {
            provide: ASSEMBLY_RECIPE_REPOSITORY,
            useExisting: PrismaAssemblyRecipeRepository,
          },
          SaveAssemblyRecipe,
          GetAssemblyRecipe,
          GetAssemblyRecipeRevision,
          ListAssemblyRecipes,
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

    async function readyCut(): Promise<{
      projectId: string;
      sourceId: string;
      jobId: string;
      artifactId: string;
    }> {
      const projectId = randomUUID();
      const sourceId = randomUUID();
      const jobId = randomUUID();
      const artifactId = randomUUID();
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
