import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../../api/src/database/prisma.service.js";
import { ReconcileAttemptCleanups } from "../../api/src/media-pipeline/application/reconcile-attempt-cleanups.js";
import { PrismaPipelineRepository } from "../../api/src/media-pipeline/infrastructure/prisma-pipeline.repository.js";
import type { ObjectStorage } from "../../api/src/projects/application/object-storage.port.js";
import { ProcessMediaJob } from "../src/application/process-media-job.js";
import type {
  MediaJobPhaseTelemetry,
  MediaProcessor,
  WorkerObjectStorage,
} from "../src/application/ports.js";
import { workerConfig } from "../src/config.js";
import { LocalSourceCache } from "../src/infrastructure/local-source-cache.js";
import { PgMediaJobRepository } from "../src/infrastructure/pg-media-job.repository.js";

describe("worker lease recovery race (PostgreSQL)", () => {
  let prisma: PrismaService;
  const projectIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    for (const id of projectIds.splice(0)) {
      await prisma.project.deleteMany({ where: { id } });
    }
  });

  afterAll(async () => prisma.onModuleDestroy());

  it("recovers attempt 1 into attempt 2 READY without allowing stale A to overwrite B", async () => {
    const { jobId } = await createQueuedCut();
    const scratchDirectory = await mkdtemp(join(tmpdir(), "cf-worker-race-"));
    const repository = new PgMediaJobRepository(workerConfig().databaseUrl);
    const reconciliation = new PrismaPipelineRepository(prisma);
    const storage = new MemoryStorage();
    const processor = new DistinctAttemptProcessor();
    const sourceCache = new LocalSourceCache({
      directory: join(scratchDirectory, "source-cache"),
      maxBytes: 1024n * 1024n,
      ttlMs: 60_000,
    });
    const telemetry: MediaJobPhaseTelemetry[] = [];
    const processJob = new ProcessMediaJob(
      repository,
      storage,
      processor,
      sourceCache,
      "integration-worker",
      {
        scratchDirectory,
        scratchSafetyBytes: 0n,
        leaseMs: 30_000,
        jobTimeoutMs: 60_000,
      },
      (event) => telemetry.push(event),
    );
    let recoveredDelivery: { jobId: string; attemptNumber: number } | undefined;

    storage.afterFirstAttemptUpload = async () => {
      await prisma.pipelineJob.update({
        where: { id: jobId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      recoveredDelivery = (await reconciliation.recoverExpiredLeases(10)).find(
        (delivery) => delivery.jobId === jobId,
      );
      await processJob.execute(jobId);
    };

    try {
      await expect(processJob.execute(jobId)).rejects.toMatchObject({
        code: "JOB_LEASE_LOST",
      });

      expect(recoveredDelivery).toEqual({ jobId, attemptNumber: 2 });
      const job = await prisma.pipelineJob.findUniqueOrThrow({
        where: { id: jobId },
        include: { attempts: { orderBy: { attemptNumber: "asc" } } },
      });
      expect(job).toMatchObject({ state: "READY", attemptCount: 2 });
      expect(
        telemetry.filter((event) => event.phase === "queue_wait"),
      ).toHaveLength(2);
      expect(
        telemetry.every(
          (event) => event.phase !== "queue_wait" || event.durationMs >= 0,
        ),
      ).toBe(true);
      expect(job.attempts).toMatchObject([
        {
          attemptNumber: 1,
          state: "FAILED_RETRYABLE",
          cleanupStatus: "COMPLETED",
        },
        {
          attemptNumber: 2,
          state: "READY",
          cleanupStatus: "NOT_REQUIRED",
        },
      ]);

      const artifact = await prisma.mediaArtifact.findUniqueOrThrow({
        where: { pipelineJobId: jobId },
      });
      const stored = storage.objects.get(artifact.objectKey);
      expect(artifact.objectKey).toContain("/attempt-2-");
      expect(artifact.sha256).toBe(sha256(fakeMp4("B")));
      expect(stored).toEqual(fakeMp4("B"));
      expect(
        [...storage.objects.keys()].some((key) => key.includes("/attempt-1-")),
      ).toBe(false);
      await new ReconcileAttemptCleanups(
        reconciliation,
        storage.asApiStorage(),
      ).execute(10);
      expect(storage.objects.get(artifact.objectKey)).toEqual(fakeMp4("B"));
    } finally {
      await sourceCache.close();
      await repository.close();
      await rm(scratchDirectory, { recursive: true, force: true });
    }
  });

  it("cleans a durable attempt output after a crash and preserves its source", async () => {
    const crashed = await prepareCrashedUpload();
    try {
      await new PrismaPipelineRepository(prisma).recoverExpiredLeases(10);
      await crashed.reconciler.execute(10);

      await expect(
        prisma.jobAttempt.findUniqueOrThrow({
          where: {
            jobId_attemptNumber: {
              jobId: crashed.jobId,
              attemptNumber: 1,
            },
          },
        }),
      ).resolves.toMatchObject({
        outputObjectKey: crashed.outputKey,
        cleanupStatus: "COMPLETED",
        cleanupAttemptCount: 1,
      });
      expect(crashed.storage.objects.has(crashed.outputKey)).toBe(false);
      expect(crashed.storage.objects.get(crashed.sourceKey)).toEqual(
        fakeMp4("S"),
      );
    } finally {
      await crashed.repository.close();
    }
  });

  it("keeps failed deletion pending and completes it on the next reconciliation", async () => {
    const crashed = await prepareCrashedUpload();
    crashed.storage.deleteFailuresRemaining = 1;
    try {
      await new PrismaPipelineRepository(prisma).recoverExpiredLeases(10);
      await crashed.reconciler.execute(10);
      await expect(
        prisma.jobAttempt.findUniqueOrThrow({
          where: {
            jobId_attemptNumber: {
              jobId: crashed.jobId,
              attemptNumber: 1,
            },
          },
        }),
      ).resolves.toMatchObject({
        cleanupStatus: "PENDING",
        cleanupAttemptCount: 1,
        cleanupLastErrorCode: "OBJECT_DELETE_FAILED",
      });
      expect(crashed.storage.objects.has(crashed.outputKey)).toBe(true);

      await crashed.reconciler.execute(10);
      await expect(
        prisma.jobAttempt.findUniqueOrThrow({
          where: {
            jobId_attemptNumber: {
              jobId: crashed.jobId,
              attemptNumber: 1,
            },
          },
        }),
      ).resolves.toMatchObject({
        cleanupStatus: "COMPLETED",
        cleanupAttemptCount: 2,
        cleanupLastErrorCode: null,
      });
      expect(crashed.storage.objects.has(crashed.outputKey)).toBe(false);
    } finally {
      await crashed.repository.close();
    }
  });

  async function prepareCrashedUpload() {
    const { projectId, jobId } = await createQueuedCut();
    const repository = new PgMediaJobRepository(workerConfig().databaseUrl);
    const reconciliation = new PrismaPipelineRepository(prisma);
    const storage = new MemoryStorage();
    const job = await repository.claim(jobId, "crashed-worker", 30_000);
    if (!job) throw new Error("TEST_JOB_CLAIM_FAILED");
    const outputKey = `sources/${projectId}/results/${jobId}/attempt-1-${job.leaseToken}.mp4`;
    const sourceKey = `sources/${projectId}/source.mp4`;
    await repository.prepareAttemptOutput(job, outputKey);
    storage.objects.set(sourceKey, fakeMp4("S"));
    storage.objects.set(outputKey, fakeMp4("A"));
    await prisma.pipelineJob.update({
      where: { id: jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    return {
      jobId,
      outputKey,
      sourceKey,
      repository,
      storage,
      reconciler: new ReconcileAttemptCleanups(
        reconciliation,
        storage.asApiStorage(),
      ),
    };
  }

  async function createQueuedCut(): Promise<{
    projectId: string;
    jobId: string;
  }> {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    projectIds.push(projectId);
    await prisma.project.create({
      data: {
        id: projectId,
        idempotencyKey: `worker-race-${randomUUID()}`,
        requestFingerprint: "a".repeat(64),
        name: "Worker recovery race",
        status: "SOURCE_READY",
        rightsConfirmedAt: new Date(),
        rightsDeclarationVersion: "upload-rights-v1",
        source: {
          create: {
            id: sourceId,
            status: "READY",
            originalFilename: "source.mp4",
            contentType: "video/mp4",
            sizeBytes: BigInt(fakeMp4("S").length),
            sha256: sha256(fakeMp4("S")),
            durationMs: 10_000,
            probedAt: new Date(),
            probeVersion: "ffprobe integration",
          },
        },
        artifacts: {
          create: {
            id: randomUUID(),
            sourceId,
            role: "SOURCE",
            status: "READY",
            objectKey: `sources/${projectId}/source.mp4`,
            sizeBytes: BigInt(fakeMp4("S").length),
            sha256: sha256(fakeMp4("S")),
            contentType: "video/mp4",
            lineageSourceId: sourceId,
            lineageSourceVersion: 1,
            recipeVersion: "source-ingest-v1",
          },
        },
        pipelineJobs: {
          create: {
            id: jobId,
            sourceId,
            type: "CUT_SEGMENT",
            idempotencyKey: `worker-race-job-${randomUUID()}`,
            recipeVersion: "stage1-cut-h264-v1",
            totalMs: 1_000,
            segment: {
              create: {
                id: randomUUID(),
                clientSegmentId: randomUUID(),
                startMs: 1_000,
                endMs: 2_000,
              },
            },
            attempts: {
              create: {
                id: randomUUID(),
                attemptNumber: 1,
                state: "QUEUED",
              },
            },
          },
        },
      },
    });
    return { projectId, jobId };
  }
});

class MemoryStorage implements WorkerObjectStorage {
  readonly objects = new Map<string, Buffer>();
  afterFirstAttemptUpload?: () => Promise<void>;
  deleteFailuresRemaining = 0;

  async download(
    _objectKey: string,
    destination: string,
    _signal: AbortSignal,
  ): Promise<void> {
    await writeFile(destination, fakeMp4("S"));
  }

  async upload(input: {
    objectKey: string;
    filePath: string;
    sha256: string;
    signal: AbortSignal;
  }): Promise<{ etag?: string }> {
    const bytes = await readFile(input.filePath);
    expect(sha256(bytes)).toBe(input.sha256);
    this.objects.set(input.objectKey, bytes);
    if (input.objectKey.includes("/attempt-1-")) {
      const callback = this.afterFirstAttemptUpload;
      this.afterFirstAttemptUpload = undefined;
      await callback?.();
    }
    return { etag: `etag-${input.sha256.slice(0, 8)}` };
  }

  async delete(objectKey: string): Promise<void> {
    if (this.deleteFailuresRemaining > 0) {
      this.deleteFailuresRemaining -= 1;
      throw new Error("simulated delete failure");
    }
    this.objects.delete(objectKey);
  }

  asApiStorage(): ObjectStorage {
    return {
      ensurePrivateBucket: async () => undefined,
      putFile: async () => ({}),
      headObject: async () => null,
      deleteObject: async (objectKey) => this.delete(objectKey),
    };
  }

  close(): void {}
}

class DistinctAttemptProcessor implements MediaProcessor {
  private cutNumber = 0;

  async probe(): Promise<{ durationMs: number; version: string }> {
    return { durationMs: 10_000, version: "ffprobe integration" };
  }

  async cut(input: {
    outputPath: string;
    onProgress(processedMs: number): void;
  }): Promise<{ version: string }> {
    this.cutNumber += 1;
    input.onProgress(1_000);
    await writeFile(
      input.outputPath,
      fakeMp4(this.cutNumber === 1 ? "A" : "B"),
    );
    return { version: "ffmpeg integration" };
  }

  async inspectOutput(): Promise<{
    durationMs: number;
    hasVideo: boolean;
    frameRate: number;
    version: string;
  }> {
    return {
      durationMs: 1_000,
      hasVideo: true,
      frameRate: 30,
      version: "ffprobe integration",
    };
  }
}

function fakeMp4(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.alloc(12, marker.charCodeAt(0)),
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
