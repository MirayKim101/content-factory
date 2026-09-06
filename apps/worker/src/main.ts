import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";

import { parseMediaJobReference } from "@content-factory/contracts";
import { Worker } from "bullmq";

import { ProcessMediaJob } from "./application/process-media-job.js";
import { workerConfig } from "./config.js";
import { FfmpegMediaProcessor } from "./infrastructure/ffmpeg-media-processor.js";
import { FfmpegAssemblyRenderer } from "./infrastructure/ffmpeg-assembly-renderer.js";
import { LocalSourceCache } from "./infrastructure/local-source-cache.js";
import { PgMediaJobRepository } from "./infrastructure/pg-media-job.repository.js";
import { S3WorkerObjectStorage } from "./infrastructure/s3-worker-object-storage.js";
import { StreamingZip64PackageExporter } from "./infrastructure/streaming-zip64-package-exporter.js";
import { ExportScratchReconciler } from "./infrastructure/export-scratch-reconciler.js";
import { verifyWorkerRollbackCompatibility } from "./rollback-compatibility.js";

if (process.argv.includes("--verify-admission-off-rollback")) {
  const rollbackConfig = workerConfig();
  await mkdir(rollbackConfig.scratchDirectory, { recursive: true });
  await chmod(rollbackConfig.scratchDirectory, 0o700);
  await verifyWorkerRollbackCompatibility({
    databaseUrl: rollbackConfig.databaseUrl,
    sourceAuthorizationPolicy: rollbackConfig.sourceAuthorizationPolicy,
    scratchDirectory: rollbackConfig.scratchDirectory,
  });
} else {
  await startWorker();
}

async function startWorker(): Promise<void> {
  const config = workerConfig();
  await mkdir(config.scratchDirectory, { recursive: true });
  await mkdir(config.sourceCacheDirectory, { recursive: true });
  await chmod(config.scratchDirectory, 0o700);
  await chmod(config.sourceCacheDirectory, 0o700);
  const workerId = `media-worker-${randomUUID()}`;
  const repository = new PgMediaJobRepository(
    config.databaseUrl,
    config.sourceAuthorizationPolicy,
  );
  const storage = new S3WorkerObjectStorage(
    config.storage.bucket,
    config.storage,
  );
  const processor = new FfmpegMediaProcessor(
    config.ffmpegPath,
    config.ffprobePath,
  );
  const assemblyRenderer = new FfmpegAssemblyRenderer(
    config.ffmpegPath,
    config.ffprobePath,
    config.ffmpegThreads,
  );
  await assemblyRenderer.verifyCapabilities(config.assemblyFontPath);
  const sourceCache = new LocalSourceCache({
    directory: config.sourceCacheDirectory,
    maxBytes: config.sourceCacheMaxBytes,
    ttlMs: config.sourceCacheTtlMs,
  });
  const packageExporter = new StreamingZip64PackageExporter();
  const processJob = new ProcessMediaJob(
    repository,
    storage,
    processor,
    sourceCache,
    workerId,
    {
      scratchDirectory: config.scratchDirectory,
      scratchSafetyBytes: config.scratchSafetyBytes,
      leaseMs: config.leaseMs,
      jobTimeoutMs: config.jobTimeoutMs,
      assemblyFontPath: config.assemblyFontPath,
    },
    (event) => console.log(JSON.stringify(event)),
    assemblyRenderer,
    packageExporter,
  );
  const exportScratchReconciler = new ExportScratchReconciler(
    repository,
    config.scratchDirectory,
    config.leaseMs,
    (event) => console.log(JSON.stringify(event)),
  );
  processJob.setRecoveredScratchBytes(
    await exportScratchReconciler.reconcile(),
  );
  const exportScratchTimer = setInterval(
    () =>
      void exportScratchReconciler
        .reconcile()
        .then((bytes) => processJob.setRecoveredScratchBytes(bytes))
        .catch((error) =>
          console.error(
            JSON.stringify({
              event: "export_scratch_reconcile_failed",
              error: error instanceof Error ? error.message : "unknown",
            }),
          ),
        ),
    Math.max(config.leaseMs, 30_000),
  );
  exportScratchTimer.unref();

  const worker = new Worker(
    config.mediaQueueName,
    async (delivery) => {
      const reference = parseMediaJobReference(delivery.data);
      console.log(
        JSON.stringify({
          event: "media_job_received",
          workerId,
          jobId: reference.jobId,
          deliveryAttempt: delivery.attemptsMade + 1,
        }),
      );
      await processJob.execute(reference.jobId);
    },
    {
      connection: {
        ...config.redis,
        maxRetriesPerRequest: null,
      },
      concurrency: config.concurrency,
    },
  );

  worker.on("completed", (job) => {
    console.log(
      JSON.stringify({
        event: "media_delivery_completed",
        workerId,
        jobId: job.id,
      }),
    );
  });
  worker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({
        event: "media_delivery_failed",
        workerId,
        jobId: job?.id,
        error: error.message,
      }),
    );
  });
  worker.on("error", (error) => {
    console.error(
      JSON.stringify({
        event: "media_worker_error",
        workerId,
        error: error.message,
      }),
    );
  });

  console.log(
    JSON.stringify({
      event: "media_worker_started",
      workerId,
      concurrency: config.concurrency,
      capabilities: [
        "SOURCE_PROBE",
        "CUT_SEGMENT",
        "MONTAGE_ASSET_PROBE",
        "ASSEMBLE_HORIZONTAL",
        "EXPORT_EDITORIAL_PACKAGE",
      ],
    }),
  );

  let closing = false;
  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    clearInterval(exportScratchTimer);
    console.log(
      JSON.stringify({ event: "media_worker_stopping", workerId, signal }),
    );
    await worker.close();
    await sourceCache.close();
    await repository.close();
    storage.close();
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(
      signal,
      () => void shutdown(signal).then(() => process.exit(0)),
    );
  }
}
