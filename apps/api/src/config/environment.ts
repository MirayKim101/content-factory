import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MEDIA_QUEUE_NAME } from "@content-factory/contracts";
import dotenv from "dotenv";

let loaded = false;

export function loadEnvironment(): void {
  if (loaded) return;
  delete process.env.MINIO_ROOT_USER;
  delete process.env.MINIO_ROOT_PASSWORD;
  const path = resolve(import.meta.dirname, "../../../../.env");
  try {
    const parsed = dotenv.parse(readFileSync(path));
    for (const name of API_ENVIRONMENT_KEYS) {
      if (process.env[name] === undefined && parsed[name] !== undefined) {
        process.env[name] = parsed[name];
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  loaded = true;
}

const API_ENVIRONMENT_KEYS = [
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
  "S3_STARTUP_TIMEOUT_MS",
  "API_MAX_UPLOAD_BYTES",
  "API_UPLOAD_TEMP_DIRECTORY",
  "API_UPLOAD_TEMP_STALE_AFTER_MS",
  "API_UPLOAD_TEMP_SWEEP_LIMIT",
  "SOURCE_PENDING_STALE_AFTER_MS",
  "SOURCE_PENDING_RECONCILE_LIMIT",
  "SOURCE_PENDING_STARTUP_TIMEOUT_MS",
  "MEDIA_RECONCILE_INTERVAL_MS",
  "MEDIA_RECONCILE_LIMIT",
  "MEDIA_QUEUE_NAME",
  "MEDIA_QUEUE_DISABLED",
  "ASSEMBLY_RENDER_ENABLED",
  "EDITORIAL_APPROVAL_ENABLED",
  "DEPLOYMENT_PROFILE",
  "SOURCE_AUTHORIZATION_POLICY",
  "API_HOST",
] as const;

export type DeploymentProfile = "local" | "other";
export type SourceAuthorizationPolicy = "manual" | "local-auto";

export interface SourceAuthorizationRuntime {
  deploymentProfile: DeploymentProfile;
  policy: SourceAuthorizationPolicy;
  apiHost: string;
}

export function resolveSourceAuthorizationRuntime(
  environment: NodeJS.ProcessEnv,
): SourceAuthorizationRuntime {
  const deploymentProfile =
    environment.DEPLOYMENT_PROFILE?.trim() === "local" ? "local" : "other";
  const policy =
    environment.SOURCE_AUTHORIZATION_POLICY?.trim() === "local-auto"
      ? "local-auto"
      : "manual";
  const apiHost = environment.API_HOST?.trim() || "127.0.0.1";

  if (
    policy === "local-auto" &&
    (deploymentProfile !== "local" || !isLoopbackHost(apiHost))
  ) {
    throw new Error("CONFIG_SOURCE_AUTHORIZATION_LOCAL_AUTO_UNSAFE");
  }

  return { deploymentProfile, policy, apiHost };
}

export function sourceAuthorizationRuntime(): SourceAuthorizationRuntime {
  loadEnvironment();
  return resolveSourceAuthorizationRuntime(process.env);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function required(name: string): string {
  loadEnvironment();
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_${name}_REQUIRED`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  loadEnvironment();
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`CONFIG_${name}_INVALID`);
  }
  return value;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = positiveInteger(name, fallback);
  if (value < minimum || value > maximum)
    throw new Error(`CONFIG_${name}_OUT_OF_RANGE`);
  return value;
}

export function databaseUrl(): string {
  const user = encodeURIComponent(required("POSTGRES_USER"));
  const password = encodeURIComponent(required("POSTGRES_PASSWORD"));
  const database = encodeURIComponent(required("POSTGRES_DB"));
  const host = process.env.POSTGRES_HOST?.trim() || "127.0.0.1";
  const port = boundedInteger("POSTGRES_PORT", 5432, 1, 65_535);
  return `postgresql://${user}:${password}@${host}:${port}/${database}?schema=public`;
}

export interface ApiEnvironment {
  apiHost: string;
  deploymentProfile: DeploymentProfile;
  sourceAuthorizationPolicy: SourceAuthorizationPolicy;
  maxUploadBytes: number;
  uploadTempDirectory: string;
  uploadTempStaleAfterMs: number;
  uploadTempSweepLimit: number;
  sourceBucket: string;
  s3Endpoint: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  storageTimeoutMs: number;
  storageStartupTimeoutMs: number;
  reconcileStaleAfterMs: number;
  reconcileLimit: number;
  reconcileStartupTimeoutMs: number;
  redisHost: string;
  redisPort: number;
  redisPassword: string;
  mediaReconcileIntervalMs: number;
  mediaReconcileLimit: number;
  mediaQueueName: string;
  mediaQueueDisabled: boolean;
  assemblyRenderEnabled: boolean;
  editorialApprovalEnabled: boolean;
}

export function apiEnvironment(): ApiEnvironment {
  loadEnvironment();
  const authorization = resolveSourceAuthorizationRuntime(process.env);
  return {
    apiHost: authorization.apiHost,
    deploymentProfile: authorization.deploymentProfile,
    sourceAuthorizationPolicy: authorization.policy,
    maxUploadBytes: boundedInteger(
      "API_MAX_UPLOAD_BYTES",
      10 * 1024 ** 3,
      1,
      5 * 1024 ** 4,
    ),
    uploadTempDirectory:
      process.env.API_UPLOAD_TEMP_DIRECTORY?.trim() ||
      resolve(process.cwd(), "tmp/uploads"),
    uploadTempStaleAfterMs: positiveInteger(
      "API_UPLOAD_TEMP_STALE_AFTER_MS",
      300_000,
    ),
    uploadTempSweepLimit: boundedInteger(
      "API_UPLOAD_TEMP_SWEEP_LIMIT",
      100,
      1,
      1_000,
    ),
    sourceBucket:
      process.env.S3_SOURCE_BUCKET?.trim() || "content-factory-sources",
    s3Endpoint: process.env.S3_ENDPOINT?.trim() || "http://127.0.0.1:9000",
    s3Region: process.env.S3_REGION?.trim() || "us-east-1",
    s3AccessKey: required("S3_ACCESS_KEY"),
    s3SecretKey: required("S3_SECRET_KEY"),
    storageTimeoutMs: positiveInteger("S3_OPERATION_TIMEOUT_MS", 7_200_000),
    storageStartupTimeoutMs: boundedInteger(
      "S3_STARTUP_TIMEOUT_MS",
      5_000,
      1,
      60_000,
    ),
    reconcileStaleAfterMs: positiveInteger(
      "SOURCE_PENDING_STALE_AFTER_MS",
      300_000,
    ),
    reconcileLimit: boundedInteger(
      "SOURCE_PENDING_RECONCILE_LIMIT",
      25,
      1,
      100,
    ),
    reconcileStartupTimeoutMs: boundedInteger(
      "SOURCE_PENDING_STARTUP_TIMEOUT_MS",
      5_000,
      1,
      60_000,
    ),
    redisHost: process.env.REDIS_HOST?.trim() || "127.0.0.1",
    redisPort: boundedInteger("REDIS_PORT", 6379, 1, 65_535),
    redisPassword: required("REDIS_PASSWORD"),
    mediaReconcileIntervalMs: boundedInteger(
      "MEDIA_RECONCILE_INTERVAL_MS",
      5_000,
      1_000,
      300_000,
    ),
    mediaReconcileLimit: boundedInteger("MEDIA_RECONCILE_LIMIT", 100, 1, 1_000),
    mediaQueueName: process.env.MEDIA_QUEUE_NAME?.trim() || MEDIA_QUEUE_NAME,
    mediaQueueDisabled: process.env.MEDIA_QUEUE_DISABLED === "1",
    assemblyRenderEnabled:
      process.env.ASSEMBLY_RENDER_ENABLED === "1" ||
      (process.env.ASSEMBLY_RENDER_ENABLED === undefined &&
        authorization.deploymentProfile === "local"),
    editorialApprovalEnabled:
      process.env.EDITORIAL_APPROVAL_ENABLED === "1" ||
      (process.env.EDITORIAL_APPROVAL_ENABLED === undefined &&
        authorization.deploymentProfile === "local"),
  };
}
