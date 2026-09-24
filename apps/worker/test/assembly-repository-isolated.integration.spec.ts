import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../../api/src/config/environment.js";
import { PrismaService } from "../../api/src/database/prisma.service.js";
import { PrismaPipelineRepository } from "../../api/src/media-pipeline/infrastructure/prisma-pipeline.repository.js";
import { PrismaEditorialExportRepository } from "../../api/src/editorial-content/infrastructure/prisma-editorial-export.repository.js";
import { EditorialExportApprovalStaleError } from "../../api/src/editorial-content/domain/editorial-export.js";
import { ProcessMediaJob } from "../src/application/process-media-job.js";
import type {
  MediaProcessor,
  SourceCache,
  WorkerObjectStorage,
} from "../src/application/ports.js";
import type { ClaimedMediaJob } from "../src/domain/media-job.js";
import { ExportScratchReconciler } from "../src/infrastructure/export-scratch-reconciler.js";
import { PgMediaJobRepository } from "../src/infrastructure/pg-media-job.repository.js";
import { S3WorkerObjectStorage } from "../src/infrastructure/s3-worker-object-storage.js";
import { StreamingZip64PackageExporter } from "../src/infrastructure/streaming-zip64-package-exporter.js";

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

    it("claims one exact editorial export, persists its scratch lease, and finalizes one result", async () => {
      const seeded = await seedExport();
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        await expect(
          repository.getAssemblyResourcePlan(seeded.exportJobId),
        ).resolves.toEqual({
          requiredScratchBytes: 2n * 1024n * 1024n + 1_128n,
        });
        const claimed = (await repository.claim(
          seeded.exportJobId,
          "worker-export-a",
          30_000,
        )) as Extract<ClaimedMediaJob, { type: "EXPORT_EDITORIAL_PACKAGE" }>;
        expect(claimed).toMatchObject({
          type: "EXPORT_EDITORIAL_PACKAGE",
          projectId: seeded.projectId,
          sourceId: seeded.sourceId,
          editorialExportPlan: {
            intentId: seeded.exportIntentId,
            approvalId: seeded.approvalId,
            video: { artifactId: seeded.renderArtifactId },
            thumbnail: { assetId: seeded.thumbnailAssetId },
            metadata: {
              title: "Exact export title",
              description: "Exact export description",
              tags: ["first", "second"],
            },
          },
        });
        await expect(
          repository.claim(seeded.exportJobId, "worker-export-b", 30_000),
        ).resolves.toBeNull();

        const leaseHash = createHash("sha256")
          .update(claimed.leaseToken)
          .digest("hex");
        const directoryName = `export-${claimed.id}-${claimed.attemptNumber}-${leaseHash.slice(0, 16)}`;
        await repository.prepareExportScratch(claimed, {
          directoryName,
          leaseHash,
          reservedBytes: 2n * 1024n * 1024n + 1_128n,
        });
        const activeLease = await prisma.pipelineJob.findUniqueOrThrow({
          where: { id: claimed.id },
          include: { attempts: true },
        });
        expect(activeLease).toMatchObject({
          state: "PROCESSING",
          leaseToken: claimed.leaseToken,
          attempts: [
            {
              scratchDirectoryName: directoryName,
              scratchLeaseHash: leaseHash,
            },
          ],
        });
        expect(activeLease.leaseExpiresAt!.getTime()).toBeGreaterThan(
          Date.now(),
        );
        expect(
          createHash("sha256").update(activeLease.leaseToken!).digest("hex"),
        ).toBe(leaseHash);
        await expect(
          repository.inspectExportScratchLease({
            jobId: claimed.id,
            attemptNumber: claimed.attemptNumber,
            directoryName,
            leaseHash,
          }),
        ).resolves.toBe("ACTIVE");
        await expect(
          repository.updateAssemblyProgress(claimed, "WRITE_ARCHIVE", 1_250),
        ).resolves.toBe(true);
        await expect(
          repository.updateAssemblyProgress(claimed, "WRITE_ARCHIVE", 1_000),
        ).resolves.toBe(true);

        const objectKey = `private/export-${claimed.id}.zip`;
        await repository.prepareAttemptOutput(claimed, objectKey);
        await repository.completeEditorialExport(claimed, {
          objectKey,
          filename: "editorial-package.zip",
          sizeBytes: 1_256n,
          sha256: "a".repeat(64),
          manifest: { manifestSchemaVersion: "editorial-export-manifest-v1" },
        });
        await expect(
          repository.isEditorialExportResultAccepted(claimed, objectKey),
        ).resolves.toBe(true);
        await expect(
          repository.completeEditorialExport(claimed, {
            objectKey,
            filename: "editorial-package.zip",
            sizeBytes: 1_256n,
            sha256: "a".repeat(64),
            manifest: { manifestSchemaVersion: "editorial-export-manifest-v1" },
          }),
        ).rejects.toThrow("JOB_LEASE_LOST");
        expect(
          await prisma.mediaArtifact.count({
            where: { pipelineJobId: seeded.exportJobId },
          }),
        ).toBe(1);
        expect(
          await prisma.editorialExportResult.count({
            where: { exportIntentId: seeded.exportIntentId },
          }),
        ).toBe(1);
        await expect(
          prisma.pipelineJob.findUniqueOrThrow({
            where: { id: seeded.exportJobId },
            include: { attempts: true },
          }),
        ).resolves.toMatchObject({
          state: "READY",
          progressAttemptNumber: 1,
          progressPhase: "FINALIZE",
          progressBasisPoints: 10_000,
          attempts: [
            {
              attemptNumber: 1,
              state: "READY",
              cleanupStatus: "NOT_REQUIRED",
              scratchDirectoryName: directoryName,
            },
          ],
        });
        await repository.clearExportScratch(claimed, directoryName);
        await expect(
          repository.inspectExportScratchLease({
            jobId: claimed.id,
            attemptNumber: claimed.attemptNumber,
            directoryName,
            leaseHash,
          }),
        ).resolves.toBe("INACTIVE");
      } finally {
        await repository.close();
      }
    });

    it("claims a v2 export with the exact component, economics, and processing snapshots", async () => {
      const seeded = await seedExport({ contractVersion: "v2" });
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        const claimed = await repository.claim(
          seeded.exportJobId,
          "worker-export-v2",
          30_000,
        );
        expect(claimed).toMatchObject({
          type: "EXPORT_EDITORIAL_PACKAGE",
          recipeVersion: "editorial-export-zip-v2",
          editorialExportPlan: {
            approvalContractVersion: "human-horizontal-approval-v2",
            exportContractVersion: "editorial-export-zip-v2",
            approvalSnapshot: {
              workflowMode: "MANUAL",
              components: [
                { component: "METADATA", mode: "MANUAL" },
                { component: "THUMBNAIL", mode: "MANUAL" },
              ],
              economics: {
                schemaVersion: "approval-economics-v2",
                totalOperatorAttentionMs: 3_000,
              },
              processingMetrics: {
                metricsSchemaVersion: "approval-metrics-v1",
                manualAttentionMs: 3_000,
              },
            },
          },
        });
      } finally {
        await repository.close();
      }
    });

    it("rejects a fingerprint-consistent v2 snapshot containing private safety data", async () => {
      const seeded = await seedExport({ contractVersion: "v2" });
      const snapshots =
        await prisma.editorialApprovalComponentSnapshot.findMany({
          where: { approvalId: seeded.approvalId },
        });
      const metadata = snapshots.find((row) => row.component === "METADATA")!;
      const thumbnail = snapshots.find((row) => row.component === "THUMBNAIL")!;
      const privateDecision = {
        credentials: "must-not-escape-worker",
        prompt: "private prompt",
      };
      const thumbnailFingerprint = manualSnapshotFingerprint(
        "THUMBNAIL",
        thumbnail.provenanceId,
        JSON.stringify(privateDecision),
      );
      const economicsFingerprint = createHash("sha256")
        .update(
          [
            "approval-economics-v2",
            "MANUAL",
            "1000",
            "2000",
            metadata.snapshotFingerprint,
            thumbnailFingerprint,
            "0",
            "0",
            "0",
            "0",
          ].join("\n"),
        )
        .digest("hex");
      await prisma.$transaction([
        prisma.editorialApprovalComponentSnapshot.update({
          where: {
            approvalId_component: {
              approvalId: seeded.approvalId,
              component: "THUMBNAIL",
            },
          },
          data: {
            imageSafetyDecision: privateDecision,
            snapshotFingerprint: thumbnailFingerprint,
          },
        }),
        prisma.editorialApprovalEconomicsV2.update({
          where: { approvalId: seeded.approvalId },
          data: { snapshotFingerprint: economicsFingerprint },
        }),
      ]);
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        await expect(
          repository.claim(seeded.exportJobId, "worker-private-safety", 30_000),
        ).resolves.toBeNull();
        const job = await prisma.pipelineJob.findUniqueOrThrow({
          where: { id: seeded.exportJobId },
        });
        expect(job).toMatchObject({
          state: "FAILED_FINAL",
          failureCode: "EXPORT_APPROVAL_STALE",
        });
        expect(job.failureMessage).not.toContain(privateDecision.credentials);
        expect(JSON.stringify(job)).not.toContain(privateDecision.prompt);
      } finally {
        await repository.close();
      }
    });

    it.runIf(process.env.STAGE2B6_REAL_STORAGE_E2E === "1")(
      "writes one exact v2 package to private object storage and refuses a stale re-admission",
      async () => {
        const seeded = await seedExport({
          contractVersion: "v2",
          realInputBytes: true,
        });
        const uniquePrefix = `sources/${seeded.projectId}/stage2b6-e2e-${randomUUID()}`;
        const videoObjectKey = `${uniquePrefix}/render.mp4`;
        const thumbnailObjectKey = `${uniquePrefix}/thumbnail.png`;
        const storage = realStorage();
        const cleanupKeys = new Set<string>([
          videoObjectKey,
          thumbnailObjectKey,
        ]);
        const scratchRoot = await mkdtemp(join(tmpdir(), "cf-stage2b6-s3-"));
        const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
        try {
          await prisma.$transaction([
            prisma.mediaArtifact.update({
              where: { id: seeded.renderArtifactId },
              data: { objectKey: videoObjectKey },
            }),
            prisma.editorialAsset.update({
              where: { id: seeded.thumbnailAssetId },
              data: { objectKey: thumbnailObjectKey },
            }),
          ]);
          await storage.uploadBytes({
            objectKey: videoObjectKey,
            bytes: seeded.videoBytes,
            contentType: "video/mp4",
            sha256: sha256(seeded.videoBytes),
          });
          await storage.uploadBytes({
            objectKey: thumbnailObjectKey,
            bytes: seeded.thumbnailBytes,
            contentType: "image/png",
            sha256: sha256(seeded.thumbnailBytes),
          });

          await new ProcessMediaJob(
            repository,
            storage,
            {} as MediaProcessor,
            {
              acquire: async () => {
                throw new Error("UNUSED_SOURCE_CACHE");
              },
              close: async () => undefined,
            } as unknown as SourceCache,
            "stage2b6-real-storage",
            {
              scratchDirectory: scratchRoot,
              scratchSafetyBytes: 0n,
              leaseMs: 30_000,
              jobTimeoutMs: 60_000,
            },
            () => undefined,
            undefined,
            new StreamingZip64PackageExporter(),
          ).execute(seeded.exportJobId);

          const result = await prisma.editorialExportResult.findUniqueOrThrow({
            where: { exportIntentId: seeded.exportIntentId },
            include: { artifact: true },
          });
          cleanupKeys.add(result.artifact.objectKey);
          const archive = await streamToBuffer(
            await storage.read(
              result.artifact.objectKey,
              new AbortController().signal,
            ),
          );
          expect(sha256(archive)).toBe(result.archiveSha256);
          const entries = readStoredZipEntries(archive);
          expect([...entries.keys()]).toEqual([
            "video.mp4",
            "thumbnail.png",
            "metadata.txt",
            "metadata.json",
            "manifest.json",
          ]);
          const manifestBytes = entries.get("manifest.json");
          expect(manifestBytes).toBeDefined();
          if (!manifestBytes) throw new Error("MANIFEST_MISSING");
          const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
            manifestSchemaVersion: string;
            entries: Array<{ name: string; sizeBytes: string; sha256: string }>;
            approvalSnapshot?: { workflowMode?: string };
          };
          expect(manifest).toMatchObject({
            manifestSchemaVersion: "editorial-export-manifest-v2",
            approvalSnapshot: { workflowMode: "MANUAL" },
          });
          expect(manifest.entries.map((entry) => entry.name)).toEqual([
            "video.mp4",
            "thumbnail.png",
            "metadata.txt",
            "metadata.json",
          ]);
          for (const entry of manifest.entries) {
            const bytes = entries.get(entry.name);
            expect(bytes).toBeDefined();
            if (!bytes) throw new Error(`MISSING_ARCHIVE_ENTRY:${entry.name}`);
            expect(entry.sizeBytes).toBe(String(bytes.length));
            expect(entry.sha256).toBe(sha256(bytes));
          }
          const publicPayload = Buffer.concat([...entries.values()]).toString(
            "utf8",
          );
          expect(publicPayload).not.toMatch(
            /objectKey|private\/|prompt|credentials/i,
          );
          expect(
            await prisma.mediaArtifact.count({
              where: { pipelineJobId: seeded.exportJobId },
            }),
          ).toBe(1);

          await prisma.editorialPackage.update({
            where: { id: seeded.editorialPackageId },
            data: { currentRevision: 2 },
          });
          const admission = new PrismaEditorialExportRepository(prisma);
          await expect(
            admission.create({
              intentId: randomUUID(),
              operationRequestId: randomUUID(),
              jobId: randomUUID(),
              attemptId: randomUUID(),
              approvalId: seeded.approvalId,
              idempotencyKey: randomUUID(),
            }),
          ).rejects.toBeInstanceOf(EditorialExportApprovalStaleError);
          expect(
            await prisma.editorialExportResult.count({
              where: { exportIntent: { approvalId: seeded.approvalId } },
            }),
          ).toBe(1);
          expect(
            await prisma.mediaArtifact.count({
              where: { pipelineJobId: seeded.exportJobId },
            }),
          ).toBe(1);
        } finally {
          await Promise.all(
            [...cleanupKeys].map((key) =>
              storage.delete(key).catch(() => undefined),
            ),
          );
          storage.close();
          await repository.close();
          await rm(scratchRoot, { recursive: true, force: true });
        }
      },
      60_000,
    );

    it.runIf(process.env.STAGE2B6_REAL_STORAGE_E2E === "1")(
      "creates a MIXED v2 approval from exact assisted lineage and exports it privately",
      async () => {
        const seeded = await seedAssistedExport();
        const storage = realStorage();
        const cleanupKeys = new Set<string>([
          seeded.videoObjectKey,
          seeded.thumbnailObjectKey,
        ]);
        const scratchRoot = await mkdtemp(join(tmpdir(), "cf-stage2b6-mixed-"));
        const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
        try {
          await storage.uploadBytes({
            objectKey: seeded.videoObjectKey,
            bytes: seeded.videoBytes,
            contentType: "video/mp4",
            sha256: sha256(seeded.videoBytes),
          });
          await storage.uploadBytes({
            objectKey: seeded.thumbnailObjectKey,
            bytes: seeded.thumbnailBytes,
            contentType: "image/png",
            sha256: sha256(seeded.thumbnailBytes),
          });
          const approvals = await integratedApprovalRepository(prisma);
          const review = await approvals.getReview(seeded.cutJobId);
          expect(review).toMatchObject({
            approvable: true,
            workflowMode: "MIXED",
            components: {
              metadata: {
                mode: "MIXED",
                citations: [{ id: seeded.citationId }],
              },
              thumbnail: {
                mode: "AI_ASSISTED",
                imageCandidateId: seeded.imageCandidateId,
              },
            },
            economicsPreview: { combinedDirectCostMicrousd: 0n },
          });
          if (!review?.candidateFingerprint)
            throw new Error("MIXED_REVIEW_MISSING");
          const approval = await approvals.create({
            approvalId: randomUUID(),
            operationRequestId: randomUUID(),
            renderId: seeded.intentId,
            editorialRevision: 1,
            candidateFingerprint: review.candidateFingerprint,
            approvalContractVersion: "human-horizontal-approval-v2",
            attention: {
              schemaVersion: "operator-attention-v2",
              preparationForegroundMs: 1_100,
              finalReviewForegroundMs: 2_200,
            },
            idempotencyKey: randomUUID(),
          });
          expect(approval).toMatchObject({
            approvalContractVersion: "human-horizontal-approval-v2",
            economicsV2: {
              workflowMode: "MIXED",
              combinedDirectCostMicrousd: 0n,
            },
          });
          expect(approval.componentSnapshots).toHaveLength(2);
          const admission = new PrismaEditorialExportRepository(prisma);
          const exported = await admission.create({
            intentId: randomUUID(),
            operationRequestId: randomUUID(),
            jobId: randomUUID(),
            attemptId: randomUUID(),
            approvalId: approval.id,
            idempotencyKey: randomUUID(),
          });
          await new ProcessMediaJob(
            repository,
            storage,
            {} as MediaProcessor,
            {
              acquire: async () => {
                throw new Error("UNUSED_SOURCE_CACHE");
              },
              close: async () => undefined,
            } as unknown as SourceCache,
            "stage2b6-mixed",
            {
              scratchDirectory: scratchRoot,
              scratchSafetyBytes: 0n,
              leaseMs: 30_000,
              jobTimeoutMs: 60_000,
            },
            () => undefined,
            undefined,
            new StreamingZip64PackageExporter(),
          ).execute(exported.delivery.jobId);
          const result = await prisma.editorialExportResult.findUniqueOrThrow({
            where: { exportIntentId: exported.view.id },
            include: { artifact: true },
          });
          cleanupKeys.add(result.artifact.objectKey);
          const entries = readStoredZipEntries(
            await streamToBuffer(
              await storage.read(
                result.artifact.objectKey,
                new AbortController().signal,
              ),
            ),
          );
          expect([...entries.keys()]).toEqual([
            "video.mp4",
            "thumbnail.png",
            "metadata.txt",
            "metadata.json",
            "manifest.json",
          ]);
          const manifestBytes = entries.get("manifest.json");
          if (!manifestBytes) throw new Error("MIXED_MANIFEST_MISSING");
          const manifestText = manifestBytes.toString("utf8");
          expect(manifestText).toContain(seeded.citationId);
          expect(manifestText).toContain(seeded.imageCandidateId);
          expect(manifestText).toContain("MIXED");
          expect(manifestText).toContain("combinedDirectCostMicrousd");
          expect(manifestText).toContain('"0"');
          expect(manifestText).not.toMatch(
            /private excerpt|private transcript|objectKey|prompt|credentials/i,
          );
          await prisma.editorialPackage.update({
            where: { id: seeded.editorialPackageId },
            data: { currentRevision: 2 },
          });
          await expect(
            admission.create({
              intentId: randomUUID(),
              operationRequestId: randomUUID(),
              jobId: randomUUID(),
              attemptId: randomUUID(),
              approvalId: approval.id,
              idempotencyKey: randomUUID(),
            }),
          ).rejects.toBeInstanceOf(EditorialExportApprovalStaleError);
          expect(
            await prisma.mediaArtifact.count({
              where: { pipelineJobId: exported.delivery.jobId },
            }),
          ).toBe(1);
        } finally {
          await Promise.all(
            [...cleanupKeys].map((key) =>
              storage.delete(key).catch(() => undefined),
            ),
          );
          storage.close();
          await repository.close();
          await rm(scratchRoot, { recursive: true, force: true });
        }
      },
      60_000,
    );

    it("rejects a v2 export when its copied economics no longer match the exact component snapshots", async () => {
      const seeded = await seedExport({ contractVersion: "v2" });
      await expect(
        isolated.query(
          `UPDATE "EditorialApprovalComponentSnapshot"
              SET "editorialPackageRevisionId"=$1
            WHERE "approvalId"=$2 AND "component"='METADATA'`,
          [randomUUID(), seeded.approvalId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await prisma.editorialApprovalEconomicsV2.update({
        where: { approvalId: seeded.approvalId },
        data: {
          metadataDirectCostMicrousd: 1n,
          combinedDirectCostMicrousd: 1n,
        },
      });
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        await expect(
          repository.claim(seeded.exportJobId, "worker-v2-tampered", 30_000),
        ).resolves.toBeNull();
        await expect(
          prisma.pipelineJob.findUniqueOrThrow({
            where: { id: seeded.exportJobId },
          }),
        ).resolves.toMatchObject({
          state: "FAILED_FINAL",
          failureCode: "EXPORT_APPROVAL_STALE",
        });
      } finally {
        await repository.close();
      }
    });

    it("rejects a historical v1 export when its approved revision has AI provenance", async () => {
      const seeded = await seedExport();
      await prisma.editorialComponentProvenance.updateMany({
        where: {
          packageRevisionId: seeded.editorialRevisionId,
          component: "METADATA",
        },
        data: { mode: "AI_ASSISTED" },
      });
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        await expect(
          repository.claim(seeded.exportJobId, "worker-v1-ai-rejected", 30_000),
        ).resolves.toBeNull();
        await expect(
          prisma.pipelineJob.findUniqueOrThrow({
            where: { id: seeded.exportJobId },
          }),
        ).resolves.toMatchObject({
          state: "FAILED_FINAL",
          failureCode: "EXPORT_APPROVAL_STALE",
        });
      } finally {
        await repository.close();
      }
    });

    it("rejects export finalization when approval becomes stale after claim", async () => {
      const seeded = await seedExport();
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      try {
        const claimed = (await repository.claim(
          seeded.exportJobId,
          "worker-export-stale",
          30_000,
        )) as Extract<ClaimedMediaJob, { type: "EXPORT_EDITORIAL_PACKAGE" }>;
        const objectKey = `private/stale-export-${claimed.id}.zip`;
        await repository.prepareAttemptOutput(claimed, objectKey);
        await prisma.editorialPackage.update({
          where: { id: seeded.editorialPackageId },
          data: { currentRevision: 2 },
        });

        await expect(
          repository.completeEditorialExport(claimed, {
            objectKey,
            filename: "must-not-exist.zip",
            sizeBytes: 1_256n,
            sha256: "a".repeat(64),
            manifest: { manifestSchemaVersion: "editorial-export-manifest-v1" },
          }),
        ).rejects.toMatchObject({ code: "EXPORT_APPROVAL_STALE" });
        await expect(
          repository.fail(
            claimed,
            "EXPORT_APPROVAL_STALE",
            "The exact editorial approval is no longer current.",
            false,
          ),
        ).resolves.toBe("FAILED_FINAL");
        expect(
          await prisma.mediaArtifact.count({
            where: { pipelineJobId: seeded.exportJobId },
          }),
        ).toBe(0);
        expect(
          await prisma.editorialExportResult.count({
            where: { exportIntentId: seeded.exportIntentId },
          }),
        ).toBe(0);
        await expect(
          prisma.pipelineJob.findUniqueOrThrow({
            where: { id: seeded.exportJobId },
            include: { attempts: true },
          }),
        ).resolves.toMatchObject({
          state: "FAILED_FINAL",
          failureCode: "EXPORT_APPROVAL_STALE",
          attempts: [
            {
              state: "FAILED_FINAL",
              cleanupStatus: "PENDING",
              outputObjectKey: objectKey,
            },
          ],
        });
      } finally {
        await repository.close();
      }
    });

    it("recovers a SIGKILL before export upload and finalizes exactly one retry result", async () => {
      const seeded = await seedExport({ realInputBytes: true });
      const repository = new PgMediaJobRepository(isolatedUrl, "local-auto");
      const scratchRoot = await mkdtemp(join(tmpdir(), "cf-export-kill-pg-"));
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const fixture = resolve(
          import.meta.dirname,
          "fixtures/export-hard-crash-worker.ts",
        );
        child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            fixture,
            isolatedUrl,
            seeded.exportJobId,
            scratchRoot,
            seeded.videoBytes.toString("base64"),
            seeded.thumbnailBytes.toString("base64"),
          ],
          {
            cwd: resolve(import.meta.dirname, ".."),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        await waitForOutput(child, "PREUPLOAD", 15_000);

        const firstAttempt = await prisma.pipelineJob.findUniqueOrThrow({
          where: { id: seeded.exportJobId },
          include: { attempts: { orderBy: { attemptNumber: "asc" } } },
        });
        expect(firstAttempt).toMatchObject({
          state: "PROCESSING",
          attemptCount: 1,
          attempts: [
            {
              attemptNumber: 1,
              state: "PROCESSING",
              scratchDirectoryName: expect.stringMatching(/^export-/),
              scratchLeaseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
              outputObjectKey: expect.stringContaining("/attempt-1-"),
            },
          ],
        });
        const crashedAttempt = firstAttempt.attempts[0]!;
        const directoryName = crashedAttempt.scratchDirectoryName!;
        const reservedBytes = crashedAttempt.scratchReservedBytes!;
        const archive = await readFile(
          join(scratchRoot, directoryName, "editorial-package.zip"),
        );
        expect(archive.subarray(0, 4)).toEqual(
          Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        );
        expect(archive.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(
          true,
        );

        expect(child.kill("SIGKILL")).toBe(true);
        const [exitCode, signal] = await once(child, "exit");
        expect(exitCode).toBeNull();
        expect(signal).toBe("SIGKILL");

        const reconciler = new ExportScratchReconciler(
          repository,
          scratchRoot,
          0,
        );
        await expect(reconciler.reconcile()).resolves.toBe(reservedBytes);
        expect(
          (await stat(join(scratchRoot, directoryName))).isDirectory(),
        ).toBe(true);
        await expect(
          prisma.jobAttempt.findFirstOrThrow({
            where: { jobId: seeded.exportJobId, attemptNumber: 1 },
            select: { outputObjectKey: true },
          }),
        ).resolves.toEqual({ outputObjectKey: crashedAttempt.outputObjectKey });

        const expiredAt = new Date(Date.now() - 60_000);
        await prisma.pipelineJob.update({
          where: { id: seeded.exportJobId },
          data: { leaseExpiresAt: expiredAt, heartbeatAt: expiredAt },
        });
        const pipeline = new PrismaPipelineRepository(prisma);
        await expect(pipeline.recoverExpiredLeases(10)).resolves.toEqual([
          { jobId: seeded.exportJobId, attemptNumber: 2 },
        ]);
        await expect(reconciler.reconcile()).resolves.toBe(0n);
        await expect(
          stat(join(scratchRoot, directoryName)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await prisma.pipelineJob.update({
          where: { id: seeded.exportJobId },
          data: { nextAttemptAt: new Date(Date.now() - 1_000) },
        });

        const uploaded = new Map<string, Buffer>();
        const storage: WorkerObjectStorage = {
          read: async (objectKey) =>
            Readable.from([
              objectKey === seeded.videoObjectKey
                ? seeded.videoBytes
                : seeded.thumbnailBytes,
            ]),
          download: async () => {
            throw new Error("UNUSED_DOWNLOAD");
          },
          upload: async (input) => {
            const bytes = await readFile(input.filePath);
            uploaded.set(input.objectKey, bytes);
            input.onProgress?.(BigInt(bytes.length));
            return { etag: "retry-etag" };
          },
          delete: async (objectKey) => {
            uploaded.delete(objectKey);
          },
          close: () => undefined,
        };
        const sourceCache = {
          acquire: async () => {
            throw new Error("UNUSED_SOURCE_CACHE");
          },
          close: async () => undefined,
        } as unknown as SourceCache;
        await new ProcessMediaJob(
          repository,
          storage,
          {} as MediaProcessor,
          sourceCache,
          "worker-retry",
          {
            scratchDirectory: scratchRoot,
            scratchSafetyBytes: 0n,
            leaseMs: 30_000,
            jobTimeoutMs: 60_000,
          },
          () => undefined,
          undefined,
          new StreamingZip64PackageExporter(),
        ).execute(seeded.exportJobId);

        expect(uploaded.size).toBe(1);
        const [outputKey, acceptedArchive] = [...uploaded.entries()][0]!;
        expect(outputKey).toContain("/attempt-2-");
        expect(outputKey).not.toBe(crashedAttempt.outputObjectKey);
        expect(acceptedArchive.includes(Buffer.from("manifest.json"))).toBe(
          true,
        );

        expect(
          await prisma.mediaArtifact.count({
            where: { pipelineJobId: seeded.exportJobId },
          }),
        ).toBe(1);
        expect(
          await prisma.editorialExportResult.count({
            where: { exportIntentId: seeded.exportIntentId },
          }),
        ).toBe(1);
        await expect(
          prisma.pipelineJob.findUniqueOrThrow({
            where: { id: seeded.exportJobId },
            include: { attempts: { orderBy: { attemptNumber: "asc" } } },
          }),
        ).resolves.toMatchObject({
          state: "READY",
          attemptCount: 2,
          attempts: [
            {
              attemptNumber: 1,
              state: "FAILED_RETRYABLE",
              scratchDirectoryName: null,
              scratchReservedBytes: null,
              outputObjectKey: crashedAttempt.outputObjectKey,
            },
            {
              attemptNumber: 2,
              state: "READY",
              outputObjectKey: outputKey,
            },
          ],
        });
        expect(
          (await readdir(scratchRoot)).filter((entry) =>
            entry.startsWith("export-"),
          ),
        ).toEqual([]);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit");
        }
        await repository.close();
        await rm(scratchRoot, { recursive: true, force: true });
      }
    });

    it("keeps migrated terminal exports readable while admission-off binaries run legacy paths", async () => {
      const terminalExport = await seedExport();
      const legacy = await seedLegacyRetryJobs();
      const assembly = await seedAssembly();
      const scratchRoot = await mkdtemp(
        join(tmpdir(), "cf-export-rollback-compat-"),
      );
      await prisma.pipelineJob.update({
        where: { id: terminalExport.exportJobId },
        data: {
          state: "FAILED_FINAL",
          failureCode: "ROLLBACK_TERMINAL_FIXTURE",
          failureMessage: "Terminal fixture retained during rollback.",
          failureRetryable: false,
          finishedAt: new Date(),
        },
      });
      await prisma.jobAttempt.updateMany({
        where: { jobId: terminalExport.exportJobId },
        data: {
          state: "FAILED_FINAL",
          failureCode: "ROLLBACK_TERMINAL_FIXTURE",
          finishedAt: new Date(),
        },
      });
      try {
        const apiRoot = resolve(import.meta.dirname, "../../api");
        const workerRoot = resolve(import.meta.dirname, "..");
        const execute = promisify(execFile);
        await execute(
          resolve(apiRoot, "node_modules/.bin/tsc"),
          ["-p", "tsconfig.build.json"],
          { cwd: apiRoot },
        );
        await execute(
          resolve(workerRoot, "node_modules/.bin/tsc"),
          ["-p", "tsconfig.build.json"],
          { cwd: workerRoot },
        );

        const inheritedEnvironment = {
          ...process.env,
          POSTGRES_DB: name,
          SOURCE_AUTHORIZATION_POLICY: "local-auto",
          DEPLOYMENT_PROFILE: "local",
          API_HOST: "127.0.0.1",
          AI_CONTEXT_ENABLED: "0",
          EDITORIAL_FRAMES_ENABLED: "0",
          RESEARCH_TEXT_ENABLED: "0",
          THUMBNAIL_SUGGESTIONS_ENABLED: "0",
          EDITORIAL_APPROVAL_ENABLED: "0",
          EDITORIAL_INTEGRATED_REVIEW_ENABLED: "0",
          EDITORIAL_EXPORT_ENABLED: "0",
          MEDIA_SCRATCH_DIRECTORY: scratchRoot,
        };
        const runnableJobIds = [
          ...legacy.jobs.map((job) => job.id),
          assembly.assemblyJobId,
        ];
        const apiOutput = await runBinary(
          resolve(apiRoot, "dist/main.js"),
          ["--verify-admission-off-rollback"],
          {
            ...inheritedEnvironment,
            ROLLBACK_COMPATIBILITY_FIXTURE: JSON.stringify({
              exportIntentId: terminalExport.exportIntentId,
              terminalExportJobId: terminalExport.exportJobId,
              runnableJobIds,
              projectId: terminalExport.projectId,
              sourceId: terminalExport.sourceId,
              cutJobId: terminalExport.cutJobId,
              editorialPackageId: terminalExport.editorialPackageId,
              montageAssetId: legacy.montageAssetId,
              assemblyRecipeId: terminalExport.recipeId,
              assemblyRenderIntentId: terminalExport.intentId,
            }),
          },
        );
        expect(apiOutput).toContain("admission_off_api_rollback_compatible");
        const legacyJobs = [
          ...legacy.jobs,
          { id: assembly.assemblyJobId, type: "ASSEMBLE_HORIZONTAL" },
        ];
        const workerOutput = await runBinary(
          resolve(workerRoot, "dist/main.js"),
          ["--verify-admission-off-rollback"],
          {
            ...inheritedEnvironment,
            ROLLBACK_COMPATIBILITY_FIXTURE: JSON.stringify({
              terminalExportJobId: terminalExport.exportJobId,
              legacyJobs,
            }),
          },
        );
        expect(workerOutput).toContain(
          "admission_off_worker_rollback_compatible",
        );
        expect(workerOutput).toContain("ASSEMBLE_HORIZONTAL");
        await expect(
          prisma.pipelineJob.findUniqueOrThrow({
            where: { id: terminalExport.exportJobId },
          }),
        ).resolves.toMatchObject({
          state: "FAILED_FINAL",
          failureCode: "ROLLBACK_TERMINAL_FIXTURE",
        });
        expect(
          await prisma.pipelineJob.count({
            where: { id: { in: runnableJobIds }, state: "PROCESSING" },
          }),
        ).toBe(runnableJobIds.length);
      } finally {
        await rm(scratchRoot, { recursive: true, force: true });
      }
    }, 30_000);

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
      return {
        projectId,
        sourceId,
        cutJobId,
        cutArtifactId,
        recipeId,
        revisionId,
        intentId,
        assemblyJobId,
      };
    }

    async function seedAssistedExport() {
      const seeded = await seedExport({
        contractVersion: "v2",
        realInputBytes: true,
      });
      await prisma.pipelineJob.delete({ where: { id: seeded.exportJobId } });
      await prisma.editorialExportIntent.delete({
        where: { id: seeded.exportIntentId },
      });
      await prisma.editorialApprovalComponentSnapshot.deleteMany({
        where: { approvalId: seeded.approvalId },
      });
      await prisma.editorialApprovalEconomicsV2.delete({
        where: { approvalId: seeded.approvalId },
      });
      await prisma.editorialApprovalMetrics.delete({
        where: { approvalId: seeded.approvalId },
      });
      await prisma.editorialApproval.delete({
        where: { id: seeded.approvalId },
      });
      const prefix = `sources/${seeded.projectId}/stage2b6-mixed-${randomUUID()}`;
      const videoObjectKey = `${prefix}/render.mp4`;
      const thumbnailObjectKey = `${prefix}/thumbnail.png`;
      await prisma.mediaArtifact.update({
        where: { id: seeded.renderArtifactId },
        data: { objectKey: videoObjectKey },
      });
      await prisma.editorialAsset.update({
        where: { id: seeded.thumbnailAssetId },
        data: { objectKey: thumbnailObjectKey },
      });

      const profileId = randomUUID();
      const identityId = randomUUID();
      const profileRevisionId = randomUUID();
      const contextId = randomUUID();
      const contextRevisionId = randomUUID();
      const promptId = randomUUID();
      const promptRevisionId = randomUUID();
      const transcriptId = randomUUID();
      const transcriptAttemptId = randomUUID();
      const transcriptArtifactId = randomUUID();
      const researchId = randomUUID();
      const researchAttemptId = randomUUID();
      const suggestionSetId = randomUUID();
      const citationId = randomUUID();
      const imageIntentId = randomUUID();
      const imageAttemptId = randomUUID();
      const imageCandidateId = randomUUID();
      const now = new Date();
      const later = new Date(Date.now() + 60_000);
      await prisma.creatorProfile.create({ data: { id: profileId } });
      await prisma.creatorProfileOfficialUrlIdentity.create({
        data: {
          id: identityId,
          creatorProfileId: profileId,
          canonicalUrl: `https://example.test/${profileId}`,
        },
      });
      await prisma.creatorProfileRevision.create({
        data: {
          id: profileRevisionId,
          creatorProfileId: profileId,
          revision: 1,
          canonicalDisplayName: "E2E creator",
          officialUrlIdentityId: identityId,
          officialUrl: `https://example.test/${profileId}`,
          primaryLanguage: "ru",
          topics: [],
          editorialNotes: "",
          restrictions: [],
        },
      });
      await prisma.sourceEditorialContext.create({
        data: {
          id: contextId,
          projectId: seeded.projectId,
          sourceId: seeded.sourceId,
          sourceVersion: 1,
        },
      });
      await prisma.sourceEditorialContextRevision.create({
        data: {
          id: contextRevisionId,
          contextId,
          revision: 1,
          projectId: seeded.projectId,
          sourceId: seeded.sourceId,
          sourceVersion: 1,
          creatorProfileId: profileId,
          creatorProfileRevisionId: profileRevisionId,
          creatorProfileRevisionNo: 1,
          sourceTitle: "E2E source",
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
          cutPipelineJobId: seeded.cutJobId,
          projectId: seeded.projectId,
          sourceId: seeded.sourceId,
          sourceVersion: 1,
          cutResultArtifactId: seeded.cutArtifactId,
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: 100n,
        },
      });
      await prisma.cutEditorialPromptRevision.create({
        data: {
          id: promptRevisionId,
          promptId,
          revision: 1,
          projectId: seeded.projectId,
          sourceId: seeded.sourceId,
          sourceVersion: 1,
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
      await prisma.transcriptEvidenceIntent.create({
        data: {
          id: transcriptId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "e2e-transcript",
          projectId: seeded.projectId,
          sourceId: seeded.sourceId,
          sourceVersion: 1,
          sourceSha256: "a".repeat(64),
          sourceAuthorizationRevision: 1,
          sourceAuthorizationBasis: "OPERATOR_ATTESTATION",
          sourceAuthorizationDeclarationVersion: "source-authorization-v1",
          sourceAuthorizationDecidedAt: now,
          cutPipelineJobId: seeded.cutJobId,
          cutResultArtifactId: seeded.cutArtifactId,
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: 100n,
          cutStartMs: 0,
          cutEndMs: 2000,
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
          adapterVersion: "local-manual-transcript-v1",
          language: "ru",
          fixture: {
            language: "ru",
            segments: [
              {
                ordinal: 0,
                startMs: 0,
                endMs: 1000,
                text: "private transcript",
              },
            ],
          },
          state: "READY",
          attemptCount: 1,
          startedAt: now,
          finishedAt: now,
        },
      });
      await prisma.transcriptEvidenceAttempt.create({
        data: {
          id: transcriptAttemptId,
          intentId: transcriptId,
          attemptNumber: 1,
          workerId: "e2e",
          leaseToken: randomUUID(),
          leaseExpiresAt: later,
          workDeadlineAt: later,
          state: "READY",
          startedAt: now,
          finishedAt: now,
        },
      });
      await prisma.transcriptEvidenceArtifact.create({
        data: {
          id: transcriptArtifactId,
          intentId: transcriptId,
          objectKey: `ai-content/transcripts/${transcriptId}/transcript.json`,
          contentType: "application/json",
          sizeBytes: 64n,
          sha256: "c".repeat(64),
          adapterVersion: "local-manual-transcript-v1",
          language: "ru",
          segments: [
            { ordinal: 0, startMs: 0, endMs: 1000, text: "private transcript" },
          ],
        },
      });
      await prisma.researchSuggestionIntent.create({
        data: {
          id: researchId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "e2e-research",
          transcriptIntentId: transcriptId,
          projectId: seeded.projectId,
          sourceId: seeded.sourceId,
          sourceVersion: 1,
          cutPipelineJobId: seeded.cutJobId,
          cutResultArtifactId: seeded.cutArtifactId,
          creatorProfileRevisionId: profileRevisionId,
          sourceContextRevisionId: contextRevisionId,
          cutPromptRevisionId: promptRevisionId,
          contextPolicyFingerprint: "d".repeat(64),
          transcriptArtifactId,
          transcriptSha256: "c".repeat(64),
          query: "fixture",
          contractVersion: "research-suggestions-v1",
          adapterVersion: "local-cited-research-v1",
          freshnessPolicyVersion: "local-freshness-v1",
          searchedAt: now,
          freshUntil: later,
          state: "READY",
        },
      });
      await prisma.researchCitation.create({
        data: {
          id: citationId,
          intentId: researchId,
          ordinal: 0,
          url: "https://example.test/citation",
          title: "E2E citation",
          publisher: "E2E",
          publishedAt: now,
          accessedAt: now,
          excerpt: "private excerpt",
          checksum: "d".repeat(64),
        },
      });
      await prisma.researchSuggestionAttempt.create({
        data: {
          id: researchAttemptId,
          intentId: researchId,
          attemptNumber: 1,
          leaseToken: randomUUID(),
          leaseExpiresAt: later,
          workDeadlineAt: later,
          state: "READY",
        },
      });
      await prisma.researchSuggestionSet.create({
        data: {
          id: suggestionSetId,
          intentId: researchId,
          attemptId: researchAttemptId,
          title: "Assisted title",
          description: "Assisted description",
          tags: ["assisted"],
          claims: [],
          citationIds: [citationId],
          basisVersion: "local-cited-research-v1",
          directCostMicrousd: 0n,
          costBasisVersion: "local-direct-ai-cost-v1",
        },
      });
      await prisma.imageSuggestionIntent.create({
        data: {
          id: imageIntentId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "e2e-image",
          projectId: seeded.projectId,
          sourceId: seeded.sourceId,
          sourceVersion: 1,
          sourceSha256: "a".repeat(64),
          sourceAuthorizationRevision: 1,
          sourceAuthorizationBasis: "OPERATOR_ATTESTATION",
          sourceAuthorizationDeclarationVersion: "source-authorization-v1",
          sourceAuthorizationDecidedAt: now,
          cutPipelineJobId: seeded.cutJobId,
          cutResultArtifactId: seeded.cutArtifactId,
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: 100n,
          cutStartMs: 0,
          cutEndMs: 2000,
          creatorProfileId: profileId,
          creatorProfileRevisionId: profileRevisionId,
          creatorProfileRevisionNo: 1,
          sourceContextId: contextId,
          sourceContextRevisionId: contextRevisionId,
          sourceContextRevisionNo: 1,
          cutPromptId: promptId,
          cutPromptRevisionId: promptRevisionId,
          cutPromptRevisionNo: 1,
          contextPolicyFingerprint: "d".repeat(64),
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
          leaseToken: randomUUID(),
          leaseExpiresAt: later,
          workDeadlineAt: later,
          state: "READY",
          objectKey: thumbnailObjectKey,
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
          objectKey: thumbnailObjectKey,
          contentType: "image/png",
          sizeBytes: BigInt(seeded.thumbnailBytes.length),
          sha256: sha256(seeded.thumbnailBytes),
          width: 320,
          height: 180,
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
          directCostMicrousd: 0n,
          costBasisVersion: "local-direct-ai-cost-v1",
        },
      });
      await prisma.editorialComponentProvenance.updateMany({
        where: {
          packageRevisionId: seeded.editorialRevisionId,
          component: "METADATA",
        },
        data: {
          mode: "MIXED",
          basisVersion: "local-cited-research-v1",
          researchIntentId: researchId,
          suggestionSetId,
        },
      });
      await prisma.editorialComponentProvenance.updateMany({
        where: {
          packageRevisionId: seeded.editorialRevisionId,
          component: "THUMBNAIL",
        },
        data: {
          mode: "AI_ASSISTED",
          basisVersion: `local-direct-ai-cost-v1:${sha256(seeded.thumbnailBytes)}`,
          imageIntentId,
          imageCandidateId,
        },
      });
      await prisma.pipelineJob.update({
        where: { id: seeded.cutJobId },
        data: {
          finishedAt: now,
          attempts: {
            create: {
              id: randomUUID(),
              attemptNumber: 1,
              state: "READY",
              startedAt: now,
              finishedAt: now,
            },
          },
        },
      });
      await prisma.jobAttempt.updateMany({
        where: { jobId: seeded.assemblyJobId },
        data: { state: "READY", startedAt: now, finishedAt: now },
      });
      await prisma.pipelineJob.update({
        where: { id: seeded.assemblyJobId },
        data: { finishedAt: now },
      });
      return {
        ...seeded,
        videoObjectKey,
        thumbnailObjectKey,
        citationId,
        imageCandidateId,
      };
    }

    async function seedExport(input?: {
      realInputBytes?: boolean;
      contractVersion?: "v1" | "v2";
    }) {
      const assembly = await seedAssembly();
      const renderArtifactId = randomUUID();
      const renderResultId = randomUUID();
      const templateId = randomUUID();
      const templateRevisionId = randomUUID();
      const thumbnailAssetId = randomUUID();
      const editorialPackageId = randomUUID();
      const editorialRevisionId = randomUUID();
      const metadataProvenanceId = randomUUID();
      const thumbnailProvenanceId = randomUUID();
      const metadataSnapshotFingerprint = manualSnapshotFingerprint(
        "METADATA",
        metadataProvenanceId,
      );
      const thumbnailSnapshotFingerprint = manualSnapshotFingerprint(
        "THUMBNAIL",
        thumbnailProvenanceId,
      );
      const economicsSnapshotFingerprint = createHash("sha256")
        .update(
          [
            "approval-economics-v2",
            "MANUAL",
            "1000",
            "2000",
            metadataSnapshotFingerprint,
            thumbnailSnapshotFingerprint,
            "0",
            "0",
            "0",
            "0",
          ].join("\n"),
        )
        .digest("hex");
      const approvalId = randomUUID();
      const exportIntentId = randomUUID();
      const exportJobId = randomUUID();
      const videoBytes = Buffer.from("real-hard-crash-video-input");
      const thumbnailBytes = Buffer.from("real-thumbnail-input");
      const videoSizeBytes = input?.realInputBytes
        ? BigInt(videoBytes.length)
        : 1_000n;
      const videoSha256 = input?.realInputBytes
        ? createHash("sha256").update(videoBytes).digest("hex")
        : "d".repeat(64);
      const thumbnailSizeBytes = input?.realInputBytes
        ? BigInt(thumbnailBytes.length)
        : 128n;
      const thumbnailSha256 = input?.realInputBytes
        ? createHash("sha256").update(thumbnailBytes).digest("hex")
        : "f".repeat(64);
      const videoObjectKey = `private/render-${renderArtifactId}.mp4`;
      const thumbnailObjectKey = `private/thumbnail-${thumbnailAssetId}.png`;

      await prisma.pipelineJob.update({
        where: { id: assembly.assemblyJobId },
        data: { state: "READY", finishedAt: new Date() },
      });
      await prisma.mediaArtifact.create({
        data: {
          id: renderArtifactId,
          projectId: assembly.projectId,
          sourceId: assembly.sourceId,
          role: "HORIZONTAL_ASSEMBLY_RESULT",
          status: "READY",
          objectKey: videoObjectKey,
          sizeBytes: videoSizeBytes,
          sha256: videoSha256,
          contentType: "video/mp4",
          lineageSourceId: assembly.sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "horizontal-render-v1",
          pipelineJobId: assembly.assemblyJobId,
          outputFilename: "render.mp4",
        },
      });
      await prisma.assemblyRenderResult.create({
        data: {
          id: renderResultId,
          renderIntentId: assembly.intentId,
          artifactId: renderArtifactId,
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
          normalizationProfileResult: "NORMALIZED",
          completedAt: new Date(),
        },
      });
      await prisma.processingTemplate.create({
        data: {
          id: templateId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "worker-export-template",
          revisions: {
            create: {
              id: templateRevisionId,
              revision: 1,
              name: "Worker export template",
              configurationVersion: "manual-editorial-v1",
            },
          },
        },
      });
      await prisma.editorialAsset.create({
        data: {
          id: thumbnailAssetId,
          projectId: assembly.projectId,
          type: "THUMBNAIL",
          status: "READY",
          idempotencyKey: randomUUID(),
          requestFingerprint: "worker-export-thumbnail",
          objectKey: thumbnailObjectKey,
          originalFilename: "thumbnail.png",
          contentType: "image/png",
          sizeBytes: thumbnailSizeBytes,
          sha256: thumbnailSha256,
          width: 320,
          height: 180,
        },
      });
      await prisma.editorialPackage.create({
        data: {
          id: editorialPackageId,
          projectId: assembly.projectId,
          pipelineJobId: assembly.cutJobId,
          cutResultArtifactId: assembly.cutArtifactId,
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: 100n,
          cutResultRecipeVersion: "stage1-cut-h264-v2",
          lineageSourceId: assembly.sourceId,
          lineageSourceVersion: 1,
          currentRevision: 1,
          revisions: {
            create: {
              id: editorialRevisionId,
              revision: 1,
              processingTemplateRevisionId: templateRevisionId,
              title: "Exact export title",
              description: "Exact export description",
              tags: ["first", "second"],
              thumbnailAssetId,
              componentProvenance: {
                create: [
                  {
                    id: metadataProvenanceId,
                    component: "METADATA",
                    mode: "MANUAL",
                    basisVersion: "manual-editorial-v1",
                  },
                  {
                    id: thumbnailProvenanceId,
                    component: "THUMBNAIL",
                    mode: "MANUAL",
                    basisVersion: "manual-editorial-v1",
                  },
                ],
              },
            },
          },
        },
      });
      await prisma.editorialApproval.create({
        data: {
          id: approvalId,
          projectId: assembly.projectId,
          sourceId: assembly.sourceId,
          sourceVersion: 1,
          cutPipelineJobId: assembly.cutJobId,
          editorialPackageId,
          editorialPackageRevisionId: editorialRevisionId,
          editorialRevision: 1,
          processingTemplateRevisionId: templateRevisionId,
          thumbnailAssetId,
          thumbnailSha256,
          thumbnailSizeBytes,
          thumbnailContentType: "image/png",
          assemblyRecipeId: assembly.recipeId,
          recipeRevisionId: assembly.revisionId,
          recipeRevision: 1,
          configurationFingerprint: "c".repeat(64),
          assemblyRenderIntentId: assembly.intentId,
          assemblyRenderResultId: renderResultId,
          renderArtifactId,
          renderArtifactSha256: videoSha256,
          renderArtifactSizeBytes: videoSizeBytes,
          renderContractVersion: "horizontal-render-v1",
          approvalContractVersion:
            input?.contractVersion === "v2"
              ? "human-horizontal-approval-v2"
              : "manual-horizontal-approval-v1",
          candidateFingerprint: "e".repeat(64),
          ...(input?.contractVersion === "v2"
            ? {
                metrics: {
                  create: {
                    metricsSchemaVersion: "approval-metrics-v1",
                    timestampBasisVersion: "persisted-job-attempt-v1",
                    cutAttemptCount: 1,
                    cutRetryCount: 0,
                    assemblyAttemptCount: 1,
                    assemblyRetryCount: 0,
                    outputDurationMs: 2_000,
                    outputBytes: videoSizeBytes,
                    manualAttentionMs: 3_000,
                    attentionMeasurementVersion: "foreground-preview-v1",
                    directProviderCostMinor: 0,
                    costCurrency: "RUB",
                    costBasisVersion: "local-direct-provider-cost-v1",
                    incompleteReasons: [],
                  },
                },
                componentSnapshots: {
                  create: ["METADATA", "THUMBNAIL"].map((component) => ({
                    id: randomUUID(),
                    component: component as "METADATA" | "THUMBNAIL",
                    provenanceId:
                      component === "METADATA"
                        ? metadataProvenanceId
                        : thumbnailProvenanceId,
                    mode: "MANUAL" as const,
                    basisVersion: "manual-editorial-v1",
                    citations: [],
                    directCostMicrousd: 0n,
                    costBasisVersion: "manual-editorial-v1",
                    incompleteReasons: [],
                    snapshotFingerprint:
                      component === "METADATA"
                        ? metadataSnapshotFingerprint
                        : thumbnailSnapshotFingerprint,
                  })),
                },
                economicsV2: {
                  create: {
                    schemaVersion: "approval-economics-v2",
                    workflowMode: "MANUAL" as const,
                    attentionSchemaVersion: "operator-attention-v2",
                    preparationForegroundMs: 1_000,
                    finalReviewForegroundMs: 2_000,
                    totalOperatorAttentionMs: 3_000,
                    metadataDirectCostMicrousd: 0n,
                    evidenceDirectCostMicrousd: 0n,
                    thumbnailDirectCostMicrousd: 0n,
                    combinedDirectCostMicrousd: 0n,
                    currency: "USD",
                    unit: "MICRO",
                    metadataCostBasisVersion: "manual-editorial-v1",
                    evidenceCostBasisVersion: "local-direct-ai-cost-v1",
                    thumbnailCostBasisVersion: "manual-editorial-v1",
                    incompleteReasons: [],
                    snapshotFingerprint: economicsSnapshotFingerprint,
                  },
                },
              }
            : {}),
        },
      });
      await prisma.editorialExportIntent.create({
        data: {
          id: exportIntentId,
          projectId: assembly.projectId,
          sourceId: assembly.sourceId,
          sourceVersion: 1,
          cutPipelineJobId: assembly.cutJobId,
          approvalId,
          approvalCandidateFingerprint: "e".repeat(64),
          editorialPackageRevisionId: editorialRevisionId,
          recipeRevisionId: assembly.revisionId,
          assemblyRenderResultId: renderResultId,
          exportContractVersion:
            input?.contractVersion === "v2"
              ? "editorial-export-zip-v2"
              : "editorial-export-zip-v1",
        },
      });
      await prisma.pipelineJob.create({
        data: {
          id: exportJobId,
          projectId: assembly.projectId,
          sourceId: assembly.sourceId,
          sourceVersion: 1,
          type: "EXPORT_EDITORIAL_PACKAGE",
          state: "QUEUED",
          payloadVersion: input?.contractVersion === "v2" ? 2 : 1,
          idempotencyKey: randomUUID(),
          recipeVersion:
            input?.contractVersion === "v2"
              ? "editorial-export-zip-v2"
              : "editorial-export-zip-v1",
          editorialExportIntentId: exportIntentId,
          attempts: {
            create: {
              id: randomUUID(),
              attemptNumber: 1,
              state: "QUEUED",
            },
          },
        },
      });
      return {
        ...assembly,
        renderArtifactId,
        thumbnailAssetId,
        editorialPackageId,
        editorialRevisionId,
        approvalId,
        exportIntentId,
        exportJobId,
        videoObjectKey,
        thumbnailObjectKey,
        videoBytes,
        thumbnailBytes,
      };
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

function manualSnapshotFingerprint(
  component: "METADATA" | "THUMBNAIL",
  provenanceId: string,
  imageSafetyDecision = "null",
): string {
  return createHash("sha256")
    .update(
      [
        "editorial-approval-component-snapshot-v2",
        component,
        provenanceId,
        "MANUAL",
        "manual-editorial-v1",
        "",
        "",
        "",
        "",
        "",
        "",
        "[]",
        imageSafetyDecision,
        "null",
        "",
        "0",
        "manual-editorial-v1",
        "[]",
      ].join("\n"),
    )
    .digest("hex");
}

function realStorage(): S3WorkerObjectStorage {
  return new S3WorkerObjectStorage(requiredEnvironment("S3_SOURCE_BUCKET"), {
    endpoint: requiredEnvironment("S3_ENDPOINT"),
    region: requiredEnvironment("S3_REGION"),
    accessKey: requiredEnvironment("S3_ACCESS_KEY"),
    secretKey: requiredEnvironment("S3_SECRET_KEY"),
  });
}

interface IntegratedApprovalRepositoryForTest {
  getReview(cutPipelineJobId: string): Promise<{
    approvable: boolean;
    candidateFingerprint: string | null;
    workflowMode: string;
    components: unknown;
    economicsPreview: unknown;
  } | null>;
  create(input: {
    approvalId: string;
    operationRequestId: string;
    renderId: string;
    editorialRevision: number;
    candidateFingerprint: string;
    approvalContractVersion: "human-horizontal-approval-v2";
    attention: {
      schemaVersion: "operator-attention-v2";
      preparationForegroundMs: number;
      finalReviewForegroundMs: number;
    };
    idempotencyKey: string;
  }): Promise<{
    id: string;
    approvalContractVersion: string;
    componentSnapshots: unknown[];
    economicsV2: unknown;
  }>;
}

async function integratedApprovalRepository(
  prisma: PrismaService,
): Promise<IntegratedApprovalRepositoryForTest> {
  const moduleUrl = new URL(
    "../../api/src/editorial-content/infrastructure/prisma-editorial-approval.repository.ts",
    import.meta.url,
  ).href;
  const loaded = (await import(moduleUrl)) as {
    PrismaEditorialApprovalRepository: new (
      service: PrismaService,
      integratedReviewEnabled: boolean,
    ) => IntegratedApprovalRepositoryForTest;
  };
  return new loaded.PrismaEditorialApprovalRepository(prisma, true);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`STAGE2B6_E2E_${name}_REQUIRED`);
  return value;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readStoredZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    if (archive.readUInt16LE(offset + 8) !== 0)
      throw new Error("STAGE2B6_E2E_NON_STORED_ZIP_ENTRY");
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const extraStart = nameStart + nameLength;
    const dataStart = extraStart + extraLength;
    const dataSize = readZip64UncompressedSize(
      archive.subarray(extraStart, dataStart),
    );
    const dataEnd = dataStart + Number(dataSize);
    entries.set(
      archive.subarray(nameStart, extraStart).toString("utf8"),
      archive.subarray(dataStart, dataEnd),
    );
    offset = dataEnd + 24;
  }
  return entries;
}

function readZip64UncompressedSize(extra: Buffer): bigint {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    if (headerId === 0x0001 && dataSize >= 16)
      return extra.readBigUInt64LE(offset + 4);
    offset += 4 + dataSize;
  }
  throw new Error("STAGE2B6_E2E_ZIP64_SIZE_MISSING");
}

async function waitForOutput(
  child: ReturnType<typeof spawn>,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `CHILD_OUTPUT_TIMEOUT expected=${expected} stdout=${stdout} stderr=${stderr}`,
        ),
      );
    }, timeoutMs);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(expected)) {
        cleanup();
        resolvePromise();
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `CHILD_EXITED_BEFORE_OUTPUT code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function runBinary(
  entrypoint: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const child = spawn(process.execPath, [entrypoint, ...arguments_], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(
      `ROLLBACK_BINARY_FAILED code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`,
    );
  }
  return stdout;
}
