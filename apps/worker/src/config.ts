import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MEDIA_QUEUE_NAME } from "@content-factory/contracts";
import dotenv from "dotenv";

function loadRootEnvironment(): void {
  const path = resolve(import.meta.dirname, "../../../.env");
  try {
    const parsed = dotenv.parse(readFileSync(path));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_${name}_REQUIRED`);
  return value;
}

function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`CONFIG_${name}_INVALID`);
  }
  return value;
}

export interface WorkerConfig {
  databaseUrl: string;
  mediaQueueName: string;
  redis: { host: string; port: number; password: string };
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
  concurrency: number;
  leaseMs: number;
  jobTimeoutMs: number;
  scratchDirectory: string;
  scratchSafetyBytes: bigint;
  ffmpegPath: string;
  ffprobePath: string;
}

export function workerConfig(): WorkerConfig {
  loadRootEnvironment();
  const user = encodeURIComponent(required("POSTGRES_USER"));
  const password = encodeURIComponent(required("POSTGRES_PASSWORD"));
  const database = encodeURIComponent(required("POSTGRES_DB"));
  const host = process.env.POSTGRES_HOST?.trim() || "127.0.0.1";
  const port = integer("POSTGRES_PORT", 5432, 1, 65_535);
  return {
    databaseUrl: `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public`,
    mediaQueueName: process.env.MEDIA_QUEUE_NAME?.trim() || MEDIA_QUEUE_NAME,
    redis: {
      host: process.env.REDIS_HOST?.trim() || "127.0.0.1",
      port: integer("REDIS_PORT", 6379, 1, 65_535),
      password: required("REDIS_PASSWORD"),
    },
    storage: {
      endpoint: process.env.S3_ENDPOINT?.trim() || "http://127.0.0.1:9000",
      region: process.env.S3_REGION?.trim() || "us-east-1",
      bucket: process.env.S3_SOURCE_BUCKET?.trim() || "content-factory-sources",
      accessKey: required("S3_ACCESS_KEY"),
      secretKey: required("S3_SECRET_KEY"),
    },
    concurrency: integer("MEDIA_WORKER_CONCURRENCY", 1, 1, 16),
    leaseMs: integer("MEDIA_JOB_LEASE_MS", 30_000, 10_000, 600_000),
    jobTimeoutMs: integer(
      "MEDIA_JOB_TIMEOUT_MS",
      7_200_000,
      60_000,
      86_400_000,
    ),
    scratchDirectory: resolve(
      process.env.MEDIA_SCRATCH_DIRECTORY?.trim() || "tmp/media-worker",
    ),
    scratchSafetyBytes:
      BigInt(integer("MEDIA_SCRATCH_SAFETY_MIB", 1024, 64, 1_048_576)) *
      1024n *
      1024n,
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH?.trim() || "ffprobe",
  };
}
