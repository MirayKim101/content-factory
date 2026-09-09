import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import dotenv from "dotenv";

let loaded = false;

function load(): void {
  if (loaded) return;
  const path = resolve(import.meta.dirname, "../../../.env");
  try {
    const parsed = dotenv.parse(readFileSync(path));
    for (const key of WORKER_KEYS) {
      if (process.env[key] === undefined && parsed[key] !== undefined)
        process.env[key] = parsed[key];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  loaded = true;
}

const WORKER_KEYS = [
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "REDIS_HOST",
  "REDIS_PORT",
  "REDIS_PASSWORD",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_SOURCE_BUCKET",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_OPERATION_TIMEOUT_MS",
  "FFMPEG_PATH",
  "FFPROBE_PATH",
  "MEDIA_PROCESS_TIMEOUT_MS",
  "WORKER_SCRATCH_DIRECTORY",
  "WORKER_SCRATCH_MAX_BYTES",
  "WORKER_HEAVY_CONCURRENCY",
  "CUT_LEASE_MS",
  "CUT_HEARTBEAT_MS",
  "CUT_RECONCILE_INTERVAL_MS",
  "CUT_SCRATCH_SAFETY_BYTES",
] as const;

function required(name: string): string {
  load();
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_${name}_REQUIRED`);
  return value;
}

function integer(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  load();
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`CONFIG_${name}_INVALID`);
  return value;
}

export interface WorkerEnvironment {
  databaseUrl: string;
  redis: { host: string; port: number; password?: string };
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    timeoutMs: number;
  };
  ffmpegPath: string;
  ffprobePath: string;
  mediaTimeoutMs: number;
  scratchDirectory: string;
  scratchMaxBytes: bigint;
  scratchSafetyBytes: bigint;
  heavyConcurrency: number;
  leaseMs: number;
  heartbeatMs: number;
  reconcileIntervalMs: number;
}

export function workerEnvironment(): WorkerEnvironment {
  load();
  const user = encodeURIComponent(required("POSTGRES_USER"));
  const password = encodeURIComponent(required("POSTGRES_PASSWORD"));
  const database = encodeURIComponent(required("POSTGRES_DB"));
  const host = process.env.POSTGRES_HOST?.trim() || "127.0.0.1";
  const port = integer("POSTGRES_PORT", 5432, 1, 65_535);
  const leaseMs = integer("CUT_LEASE_MS", 120_000, 1_000);
  const heartbeatMs = integer("CUT_HEARTBEAT_MS", 30_000, 250);
  if (heartbeatMs >= leaseMs)
    throw new Error("CONFIG_CUT_HEARTBEAT_MS_INVALID");
  return {
    databaseUrl: `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public`,
    redis: {
      host: process.env.REDIS_HOST?.trim() || "127.0.0.1",
      port: integer("REDIS_PORT", 6379, 1, 65_535),
      ...(process.env.REDIS_PASSWORD?.trim()
        ? { password: process.env.REDIS_PASSWORD.trim() }
        : {}),
    },
    s3: {
      endpoint: process.env.S3_ENDPOINT?.trim() || "http://127.0.0.1:9000",
      region: process.env.S3_REGION?.trim() || "us-east-1",
      bucket: process.env.S3_SOURCE_BUCKET?.trim() || "content-factory-sources",
      accessKey: required("S3_ACCESS_KEY"),
      secretKey: required("S3_SECRET_KEY"),
      timeoutMs: integer("S3_OPERATION_TIMEOUT_MS", 7_200_000),
    },
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || "/usr/bin/ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH?.trim() || "/usr/bin/ffprobe",
    mediaTimeoutMs: integer("MEDIA_PROCESS_TIMEOUT_MS", 7_200_000),
    scratchDirectory:
      process.env.WORKER_SCRATCH_DIRECTORY?.trim() ||
      "/tmp/content-factory-worker",
    scratchMaxBytes: BigInt(
      integer("WORKER_SCRATCH_MAX_BYTES", 20 * 1024 ** 3),
    ),
    scratchSafetyBytes: BigInt(
      integer("CUT_SCRATCH_SAFETY_BYTES", 512 * 1024 ** 2),
    ),
    heavyConcurrency: integer("WORKER_HEAVY_CONCURRENCY", 1, 1, 32),
    leaseMs,
    heartbeatMs,
    reconcileIntervalMs: integer(
      "CUT_RECONCILE_INTERVAL_MS",
      5_000,
      250,
      300_000,
    ),
  };
}
