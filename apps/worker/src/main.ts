import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { parseMediaJobReference } from "@content-factory/contracts";
import { Worker } from "bullmq";

import { ProcessMediaJob } from "./application/process-media-job.js";
import { workerConfig } from "./config.js";
import { FfmpegMediaProcessor } from "./infrastructure/ffmpeg-media-processor.js";
import { PgMediaJobRepository } from "./infrastructure/pg-media-job.repository.js";
import { S3WorkerObjectStorage } from "./infrastructure/s3-worker-object-storage.js";

const config = workerConfig();
await mkdir(config.scratchDirectory, { recursive: true });
const workerId = `media-worker-${randomUUID()}`;
const repository = new PgMediaJobRepository(config.databaseUrl);
const storage = new S3WorkerObjectStorage(
  config.storage.bucket,
  config.storage,
);
const processor = new FfmpegMediaProcessor(
  config.ffmpegPath,
  config.ffprobePath,
);
const processJob = new ProcessMediaJob(
  repository,
  storage,
  processor,
  workerId,
  {
    scratchDirectory: config.scratchDirectory,
    scratchSafetyBytes: config.scratchSafetyBytes,
    leaseMs: config.leaseMs,
    jobTimeoutMs: config.jobTimeoutMs,
  },
);

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
  }),
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(
    JSON.stringify({ event: "media_worker_stopping", workerId, signal }),
  );
  await worker.close();
  await repository.close();
  storage.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal).then(() => process.exit(0)));
}
