import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../../api/src/config/environment.js";
import { PrismaService } from "../../api/src/database/prisma.service.js";
import { PrismaPipelineRepository } from "../../api/src/media-pipeline/infrastructure/prisma-pipeline.repository.js";
import type { ClaimedMediaJob } from "../src/domain/media-job.js";
import { PgMediaJobRepository } from "../src/infrastructure/pg-media-job.repository.js";

describe.runIf(process.env.ASSEMBLY_REPOSITORY_ISOLATED_TESTS === "1")(
  "assembly worker repository isolated PostgreSQL",
  () => {
    const name = `content_factory_worker_assembly_${randomUUID().replaceAll("-", "")}`;
    const previous = {
      POSTGRES_DB: process.env.POSTGRES_DB,
      SOURCE_AUTHORIZATION_POLICY: process.env.SOURCE_AUTHORIZATION_POLICY,
      DEPLOYMENT_PROFILE: process.env.DEPLOYMENT_PROFILE,
      API_HOST: process.env.API_HOST,
    };
    let admin: Pool;
    let isolated: Pool;
    let prisma: PrismaService;
    let isolatedUrl: string;
    let created = false;

    beforeAll(async () => {
      const base = new URL(databaseUrl());
      if (!/^content_factory_worker_assembly_[a-f0-9]{32}$/.test(name)) {
        throw new Error("ISOLATION_GUARD_FAILED");
      }
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
      process.env.SOURCE_AUTHORIZATION_POLICY = "local-auto";
      process.env.DEPLOYMENT_PROFILE = "local";
      process.env.API_HOST = "127.0.0.1";
      prisma = new PrismaService();
      await prisma.onModuleInit();
    }, 60_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await isolated?.end();
      restore("POSTGRES_DB", previous.POSTGRES_DB);
      restore(
        "SOURCE_AUTHORIZATION_POLICY",
        previous.SOURCE_AUTHORIZATION_POLICY,
      );
      restore("DEPLOYMENT_PROFILE", previous.DEPLOYMENT_PROFILE);
      restore("API_HOST", previous.API_HOST);
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin?.end();
    });

    it("claims once, fences stale leases, defers a due retry, retries, and finalizes one result", async () => {
      const seeded = await seedAssembly();
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        const first = await repository.claim(
          seeded.assemblyJobId,
          "worker-a",
          30_000,
        );
        expect(first?.type).toBe("ASSEMBLE_HORIZONTAL");
        expect(
          await repository.claim(seeded.assemblyJobId, "worker-b", 30_000),
        ).toBeNull();
        const assembly = first as Extract<
          ClaimedMediaJob,
          { type: "ASSEMBLE_HORIZONTAL" }
        >;
        await expect(
          repository.completeAssembly(
            { ...assembly, leaseToken: randomUUID() },
            result("private/stale.mp4"),
          ),
        ).rejects.toThrow("JOB_LEASE_LOST");

        await expect(
          repository.fail(
            assembly,
            "OBJECT_STORAGE_TRANSIENT",
            "Retryable storage failure.",
            true,
          ),
        ).resolves.toBe("RETRY_SCHEDULED");
        await prisma.pipelineJob.update({
          where: { id: seeded.assemblyJobId },
          data: { nextAttemptAt: new Date(Date.now() - 1_000) },
        });
        const deferredUntil = new Date(Date.now() + 60_000);
        await repository.deferAssemblyAdmission(
          seeded.assemblyJobId,
          "INSUFFICIENT_SCRATCH",
          deferredUntil,
        );
        const deferred = await prisma.pipelineJob.findUniqueOrThrow({
          where: { id: seeded.assemblyJobId },
        });
        expect(deferred).toMatchObject({
          state: "RETRY_WAIT",
          admissionReason: "INSUFFICIENT_SCRATCH",
          attemptCount: 1,
        });
        expect(deferred.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());

        await prisma.pipelineJob.update({
          where: { id: seeded.assemblyJobId },
          data: { nextAttemptAt: new Date(Date.now() - 1_000) },
        });
        const second = (await repository.claim(
          seeded.assemblyJobId,
          "worker-b",
          30_000,
        )) as Extract<ClaimedMediaJob, { type: "ASSEMBLE_HORIZONTAL" }>;
        expect(second.attemptNumber).toBe(2);
        const accepted = result("private/accepted.mp4");
        await repository.prepareAttemptOutput(second, accepted.objectKey);
        await repository.completeAssembly(second, accepted);
        await expect(
          repository.completeAssembly(second, accepted),
        ).rejects.toThrow("JOB_LEASE_LOST");
        await expect(
          repository.isAssemblyResultAccepted(second, accepted.objectKey),
        ).resolves.toBe(true);
        expect(
          await prisma.mediaArtifact.count({
            where: { pipelineJobId: seeded.assemblyJobId },
          }),
        ).toBe(1);
        expect(
          await prisma.assemblyRenderResult.count({
            where: { renderIntentId: seeded.intentId },
          }),
        ).toBe(1);
        await expect(
          prisma.pipelineJob.findUniqueOrThrow({
            where: { id: seeded.assemblyJobId },
            include: { attempts: { orderBy: { attemptNumber: "asc" } } },
          }),
        ).resolves.toMatchObject({
          state: "READY",
          attemptCount: 2,
          attempts: [
            { attemptNumber: 1, state: "FAILED_RETRYABLE" },
            { attemptNumber: 2, state: "READY" },
          ],
        });
      } finally {
        await repository.close();
      }
    });

    it("fails an expired assembly lease closed when exact source authorization is revoked", async () => {
      const seeded = await seedAssembly();
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        const claimed = await repository.claim(
          seeded.assemblyJobId,
          "worker-revoked",
          30_000,
        );
        expect(claimed?.type).toBe("ASSEMBLE_HORIZONTAL");
        await prisma.pipelineJob.update({
          where: { id: seeded.assemblyJobId },
          data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        await prisma.sourceAuthorization.delete({
          where: {
            sourceId_sourceVersion: {
              sourceId: seeded.sourceId,
              sourceVersion: 1,
            },
          },
        });

        await expect(
          new PrismaPipelineRepository(prisma).recoverExpiredLeases(10),
        ).resolves.toEqual([]);
        await expect(
          prisma.pipelineJob.findUniqueOrThrow({
            where: { id: seeded.assemblyJobId },
            include: { attempts: true },
          }),
        ).resolves.toMatchObject({
          state: "FAILED_FINAL",
          failureCode: "ASSEMBLY_INPUT_INVALID",
          failureRetryable: false,
          leaseToken: null,
          nextAttemptAt: null,
          attempts: [{ attemptNumber: 1, state: "FAILED_FINAL" }],
        });
      } finally {
        await repository.close();
      }
    });

    it("atomically clears a due retry schedule when claiming every legacy media job type", async () => {
      const seeded = await seedLegacyRetryJobs();
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        for (const job of seeded.jobs) {
          const claimed = await repository.claim(
            job.id,
            `worker-${job.type}`,
            30_000,
          );
          expect(claimed).toMatchObject({
            id: job.id,
            type: job.type,
            attemptNumber: 2,
          });
          await expect(
            prisma.pipelineJob.findUniqueOrThrow({ where: { id: job.id } }),
          ).resolves.toMatchObject({
            state: "PROCESSING",
            attemptCount: 2,
            nextAttemptAt: null,
          });
        }
      } finally {
        await repository.close();
      }
    });

    it("does not claim any legacy media job before its retry schedule is due", async () => {
      const seeded = await seedLegacyRetryJobs(new Date(Date.now() + 60_000));
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        for (const job of seeded.jobs) {
          await expect(
            repository.claim(job.id, `early-worker-${job.type}`, 30_000),
          ).resolves.toBeNull();
          await expect(
            prisma.pipelineJob.findUniqueOrThrow({
              where: { id: job.id },
              include: { attempts: true },
            }),
          ).resolves.toMatchObject({
            state: "RETRY_WAIT",
            attemptCount: 1,
            attempts: [{ attemptNumber: 1, state: "FAILED_RETRYABLE" }],
          });
        }
      } finally {
        await repository.close();
      }
    });

    it("clears the retry schedule when every legacy media job exhausts its retry budget", async () => {
      const seeded = await seedLegacyRetryJobs(
        new Date(Date.now() - 1_000),
        true,
      );
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        for (const job of seeded.jobs) {
          await expect(
            repository.claim(job.id, `exhausted-worker-${job.type}`, 30_000),
          ).resolves.toBeNull();
          await expect(
            prisma.pipelineJob.findUniqueOrThrow({ where: { id: job.id } }),
          ).resolves.toMatchObject({
            state: "FAILED_FINAL",
            attemptCount: 3,
            nextAttemptAt: null,
            failureCode: "RETRY_BUDGET_EXHAUSTED",
            failureRetryable: false,
          });
        }
        await expect(
          prisma.montageAsset.findUniqueOrThrow({
            where: { id: seeded.montageAssetId },
          }),
        ).resolves.toMatchObject({
          status: "FAILED_FINAL",
          failureCode: "RETRY_BUDGET_EXHAUSTED",
          cleanupStatus: "PENDING",
        });
      } finally {
        await repository.close();
      }
    });

    async function seedLegacyRetryJobs(
      nextAttemptAt = new Date(Date.now() - 1_000),
      exhausted = false,
    ) {
      const projectId = randomUUID();
      const sourceId = randomUUID();
      await prisma.project.create({
        data: {
          id: projectId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "legacy-retry-claim-test",
          name: "Legacy retry claim test",
          status: "SOURCE_READY",
          source: {
            create: {
              id: sourceId,
              status: "READY",
              originalFilename: "source.mp4",
              contentType: "video/mp4",
              sizeBytes: 1_000n,
              sha256: "e".repeat(64),
              durationMs: 10_000,
              authorizations: {
                create: {
                  sourceVersion: 1,
                  status: "CLEARED",
                  basis: "LOCAL_DEVELOPMENT_AUTO",
                  declarationVersion: "local-development-auto-v1",
                  decidedAt: new Date(),
                },
              },
            },
          },
        },
      });
      await prisma.mediaArtifact.create({
        data: {
          id: randomUUID(),
          projectId,
          sourceId,
          role: "SOURCE",
          status: "READY",
          objectKey: `private/source-${sourceId}.mp4`,
          sizeBytes: 1_000n,
          sha256: "e".repeat(64),
          contentType: "video/mp4",
          lineageSourceId: sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "source-upload-v1",
        },
      });
      const montageAssetId = randomUUID();
      await prisma.montageAsset.create({
        data: {
          id: montageAssetId,
          projectId,
          sourceId,
          sourceVersion: 1,
          kind: "INTRO",
          status: "PROBE_PENDING",
          idempotencyKey: randomUUID(),
          requestFingerprint: "legacy-retry-montage",
          objectKey: `private/montage-${montageAssetId}.mp4`,
          originalFilename: "intro.mp4",
          contentType: "video/mp4",
          sizeBytes: 100n,
          sha256: "f".repeat(64),
          rightsBasis: "LOCAL_DEVELOPMENT_AUTO",
          rightsDeclaration: "montage-local-development-auto-v1",
          rightsDecidedAt: new Date(),
          uploadExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const jobs = [
        {
          id: randomUUID(),
          type: "SOURCE_PROBE" as const,
          recipeVersion: "source-probe-v1",
        },
        {
          id: randomUUID(),
          type: "CUT_SEGMENT" as const,
          recipeVersion: "stage1-cut-h264-v2",
        },
        {
          id: randomUUID(),
          type: "MONTAGE_ASSET_PROBE" as const,
          recipeVersion: "montage-asset-probe-v1",
        },
      ];
      for (const job of jobs) {
        await prisma.pipelineJob.create({
          data: {
            id: job.id,
            projectId,
            sourceId,
            sourceVersion: 1,
            type: job.type,
            state: "RETRY_WAIT",
            idempotencyKey: randomUUID(),
            recipeVersion: job.recipeVersion,
            attemptCount: exhausted ? 3 : 1,
            retryBudget: 2,
            nextAttemptAt,
            ...(job.type === "MONTAGE_ASSET_PROBE" ? { montageAssetId } : {}),
            ...(job.type === "CUT_SEGMENT"
              ? {
                  segment: {
                    create: {
                      id: randomUUID(),
                      clientSegmentId: randomUUID(),
                      startMs: 1_000,
                      endMs: 2_000,
                    },
                  },
                }
              : {}),
            attempts: {
              create: Array.from({ length: exhausted ? 3 : 1 }, (_, index) => ({
                id: randomUUID(),
                attemptNumber: index + 1,
                state: "FAILED_RETRYABLE" as const,
                failureCode: "TRANSIENT_TEST_FAILURE",
                finishedAt: new Date(),
              })),
            },
          },
        });
      }
      return { jobs, montageAssetId };
    }

    async function seedAssembly() {
      const projectId = randomUUID();
      const sourceId = randomUUID();
      const cutJobId = randomUUID();
      const cutArtifactId = randomUUID();
      const recipeId = randomUUID();
      const revisionId = randomUUID();
      const intentId = randomUUID();
      const assemblyJobId = randomUUID();
      await prisma.project.create({
        data: {
          id: projectId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "worker-assembly-test",
          name: "Worker assembly repository test",
          status: "SOURCE_READY",
          source: {
            create: {
              id: sourceId,
              status: "READY",
              originalFilename: "source.mp4",
              contentType: "video/mp4",
              sizeBytes: 1_000n,
              sha256: "a".repeat(64),
              durationMs: 2_000,
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
          id: cutJobId,
          projectId,
          sourceId,
          sourceVersion: 1,
          type: "CUT_SEGMENT",
          state: "READY",
          idempotencyKey: randomUUID(),
          recipeVersion: "stage1-cut-h264-v2",
          totalMs: 2_000,
          segment: {
            create: {
              id: randomUUID(),
              clientSegmentId: randomUUID(),
              startMs: 0,
              endMs: 2_000,
            },
          },
        },
      });
      await prisma.mediaArtifact.create({
        data: {
          id: cutArtifactId,
          projectId,
          sourceId,
          role: "CUT_RESULT",
          status: "READY",
          objectKey: `private/cut-${cutArtifactId}.mp4`,
          sizeBytes: 100n,
          sha256: "b".repeat(64),
          contentType: "video/mp4",
          lineageSourceId: sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "stage1-cut-h264-v2",
          pipelineJobId: cutJobId,
        },
      });
      await prisma.assemblyRecipe.create({
        data: {
          id: recipeId,
          projectId,
          pipelineJobId: cutJobId,
          cutResultArtifactId: cutArtifactId,
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: 100n,
          cutResultRecipeVersion: "stage1-cut-h264-v2",
          lineageSourceId: sourceId,
          lineageSourceVersion: 1,
          cutDurationMs: 2_000,
          currentRevision: 1,
          revisions: {
            create: {
              id: revisionId,
              revision: 1,
              schemaVersion: "horizontal-assembly-v1",
              configurationFingerprint: "c".repeat(64),
              audioProfileVersion: "youtube-stereo-v1",
              encodingProfileVersion: "youtube-h264-v1",
            },
          },
        },
      });
      await prisma.assemblyRenderIntent.create({
        data: {
          id: intentId,
          projectId,
          sourceId,
          sourceVersion: 1,
          cutPipelineJobId: cutJobId,
          cutResultArtifactId: cutArtifactId,
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: 100n,
          cutResultRecipeVersion: "stage1-cut-h264-v2",
          assemblyRecipeId: recipeId,
          recipeRevisionId: revisionId,
          recipeRevision: 1,
          configurationFingerprint: "c".repeat(64),
          renderContractVersion: "horizontal-render-v1",
          audioProfileVersion: "youtube-stereo-v1",
          encodingProfileVersion: "youtube-h264-v1",
          expectedDurationMs: 2_000,
        },
      });
      await prisma.pipelineJob.create({
        data: {
          id: assemblyJobId,
          projectId,
          sourceId,
          sourceVersion: 1,
          type: "ASSEMBLE_HORIZONTAL",
          state: "QUEUED",
          idempotencyKey: randomUUID(),
          recipeVersion: "horizontal-render-v1",
          totalMs: 2_000,
          assemblyRenderIntentId: intentId,
          attempts: {
            create: {
              id: randomUUID(),
              attemptNumber: 1,
              state: "QUEUED",
            },
          },
        },
      });
      return { sourceId, intentId, assemblyJobId };
    }

    function result(objectKey: string) {
      return {
        objectKey,
        filename: "assembled.mp4",
        sizeBytes: 1_000n,
        sha256: "d".repeat(64),
        durationMs: 2_000,
        width: 320,
        height: 180,
        fpsNumerator: 25,
        fpsDenominator: 1,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        audioCodec: "aac",
        audioSampleRate: 48_000,
        audioChannels: 2,
        ffmpegVersion: "ffmpeg-test",
        ffprobeVersion: "ffprobe-test",
        integratedLoudnessLufs: null,
        truePeakDbtp: null,
        normalizationProfileResult: "SILENT",
      };
    }
  },
);

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
