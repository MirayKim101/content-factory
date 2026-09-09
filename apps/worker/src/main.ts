import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import {
  ManualCutWorker,
  PrismaCutJobRepository,
  isCutQueueMessageV1,
  systemClock,
} from "@content-factory/manual-cut";
import { PrismaClient } from "@content-factory/prisma-client";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { workerEnvironment } from "./environment.js";
import { FfmpegMediaRuntime } from "./ffmpeg-media-runtime.js";
import { observeConsumer, passStartupBarrier } from "./lifecycle.js";
import { S3WorkerStorage } from "./s3-worker-storage.js";
import { FilesystemScratchCapacity } from "./scratch-capacity.js";

const QUEUE_NAME = "content-factory-media-v1";
const config = workerEnvironment();
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl }),
});
const repository = new PrismaCutJobRepository(prisma);
const storage = new S3WorkerStorage(config.s3);
const runner = new ManualCutWorker(
  repository,
  storage,
  new FfmpegMediaRuntime(
    config.ffmpegPath,
    config.ffprobePath,
    config.mediaTimeoutMs,
  ),
  new FilesystemScratchCapacity(
    config.scratchDirectory,
    config.scratchMaxBytes,
  ),
  systemClock,
  {
    scratchRoot: config.scratchDirectory,
    leaseMs: config.leaseMs,
    heartbeatMs: config.heartbeatMs,
    heavyConcurrency: config.heavyConcurrency,
    scratchSafetyBytes: config.scratchSafetyBytes,
    outputBitsPerSecond: 6_000_000n,
    scratchCapacityBytes: config.scratchMaxBytes,
    cleanupTimeoutMs: Math.min(config.s3.timeoutMs, 30_000),
  },
  {
    emit: ({ name, ...fields }) => event(name, fields),
  },
);
const redisOptions = {
  host: config.redis.host,
  port: config.redis.port,
  ...(config.redis.password ? { password: config.redis.password } : {}),
  maxRetriesPerRequest: null,
  protocol: 2 as const,
};
const workerConnection = new Redis(redisOptions);
const producerConnection = new Redis({
  ...redisOptions,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
workerConnection.on("error", (error) =>
  event("worker_redis_error", { code: safeError(error) }),
);
producerConnection.on("error", (error) =>
  event("producer_redis_error", { code: safeError(error) }),
);
const queue = new Queue<{ jobId: string }>(QUEUE_NAME, {
  connection: producerConnection,
});
const worker = new Worker<{ jobId: string }>(
  QUEUE_NAME,
  async (delivery) => {
    if (!isCutQueueMessageV1(delivery.data)) {
      event("cut_delivery_rejected", { deliveryId: delivery.id ?? null });
      return;
    }
    const outcome = await runner.execute(delivery.data.jobId);
    event("cut_delivery_finished", { jobId: delivery.data.jobId, outcome });
  },
  {
    connection: workerConnection,
    concurrency: Math.max(2, config.heavyConcurrency + 1),
    autorun: false,
  },
);
worker.on("error", (error) =>
  event("cut_worker_error", { code: safeError(error) }),
);
worker.on("failed", (delivery, error) =>
  event("cut_delivery_failed", {
    jobId: delivery?.data.jobId ?? null,
    code: safeError(error),
  }),
);

const readyFile = join(config.scratchDirectory, "worker-ready");
let reconciling = false;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
async function reconcile(failClosed = false): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    await runner.reconcile();
    const runnable = await repository.findRunnable(new Date(), 100);
    for (const jobId of runnable) {
      await queue.add(
        "manual-cut-job-v1",
        { jobId },
        { jobId, attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
    }
    if (runnable.length > 0)
      event("cut_reconciled", { count: runnable.length });
  } catch (error) {
    event("cut_reconcile_failed", { code: safeError(error) });
    if (failClosed) throw error;
  } finally {
    reconciling = false;
  }
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (reconcileTimer) clearInterval(reconcileTimer);
  event("worker_stopping", { signal });
  await unlink(readyFile).catch(() => undefined);
  await worker.close().catch(() => undefined);
  await queue.close().catch(() => undefined);
  workerConnection.disconnect();
  producerConnection.disconnect();
  storage.destroy();
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await passStartupBarrier({
  connectDatabase: () => prisma.$connect(),
  reconcile: () => reconcile(true),
  waitForConsumer: () => worker.waitUntilReady(),
});
observeConsumer(worker.run(), async (error) => {
  event("cut_worker_stopped_unexpectedly", { code: safeError(error) });
  await shutdown("WORKER_RUN_FAILED", 1);
});
if (stopping) throw new Error("WORKER_RUN_FAILED");
await writeFile(readyFile, `${process.pid}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
if (stopping) {
  await unlink(readyFile).catch(() => undefined);
} else {
  event("worker_ready", {
    queue: QUEUE_NAME,
    concurrency: config.heavyConcurrency,
  });
  reconcileTimer = setInterval(
    () => void reconcile(),
    config.reconcileIntervalMs,
  );
}

function event(name: string, fields: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ event: name, at: new Date().toISOString(), ...fields })}\n`,
  );
}

function safeError(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,100}$/.test(error.message))
    return error.message;
  return "UNEXPECTED_ERROR";
}
