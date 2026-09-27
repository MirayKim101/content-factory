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
  frameExtractionCapacity: number;
  frameWorkDeadlineMs: number;
  scratchDirectory: string;
  scratchSafetyBytes: bigint;
  sourceCacheDirectory: string;
  sourceCacheMaxBytes: bigint;
  sourceCacheTtlMs: number;
  ffmpegPath: string;
  ffprobePath: string;
  ffmpegThreads: number;
  assemblyFontPath: string;
  sourceAuthorizationPolicy: "manual" | "local-auto";
}

export interface PublicationSessionKeyConfig {
  currentKeyVersion: string;
  keys: ReadonlyMap<string, Buffer>;
}

export interface YoutubePublishingConfig extends PublicationSessionKeyConfig {
  clientId: string;
  clientSecret: string;
  credentials: Array<{
    channelId?: string;
    externalChannelRef: string;
    refreshToken: string;
  }>;
}

export interface TikTokPublishingConfig extends PublicationSessionKeyConfig {
  clientKey: string;
  clientSecret: string;
  credentials: Array<{
    channelId?: string;
    externalChannelRef: string;
    refreshToken: string;
  }>;
}

export interface OpenAiClipGenerationConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
}

export function publicationWorkerAdmissionEnabled(
  environment: NodeJS.ProcessEnv,
): boolean {
  return environment.PUBLISHING_ENABLED?.trim() === "1";
}

export interface TwitchVodMediaGatewayConfig {
  baseUrl: string;
  bearerToken: string;
  timeoutMs: number;
}

export function twitchVodAutoIngestConfig(
  environment: NodeJS.ProcessEnv,
): TwitchVodMediaGatewayConfig | null {
  if (environment.TWITCH_VOD_AUTO_INGEST_ENABLED?.trim() !== "1") return null;
  const gateway = twitchVodMediaGatewayConfig(environment);
  if (!gateway) throw new Error("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_REQUIRED");
  return gateway;
}

export function twitchVodMediaGatewayConfig(
  environment: NodeJS.ProcessEnv,
): TwitchVodMediaGatewayConfig | null {
  if (environment.TWITCH_VOD_MEDIA_GATEWAY_ENABLED?.trim() !== "1") return null;
  const rawBaseUrl = environment.TWITCH_VOD_MEDIA_GATEWAY_BASE_URL?.trim();
  const bearerToken = environment.TWITCH_VOD_MEDIA_GATEWAY_TOKEN?.trim();
  if (!rawBaseUrl)
    throw new Error("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_BASE_URL_REQUIRED");
  if (!bearerToken)
    throw new Error("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_TOKEN_REQUIRED");
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_BASE_URL_INVALID");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        environment.DEPLOYMENT_PROFILE?.trim() === "local" &&
        url.protocol === "http:" &&
        loopback
      ))
  )
    throw new Error("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_BASE_URL_UNSAFE");
  const baseUrl = url.toString().replace(/\/$/, "");
  return {
    baseUrl,
    bearerToken,
    timeoutMs: integerFromEnvironment(
      environment,
      "TWITCH_VOD_MEDIA_REQUEST_TIMEOUT_MS",
      30_000,
      5_000,
      300_000,
    ),
  };
}

export function openAiClipGenerationConfig(
  environment: NodeJS.ProcessEnv,
): OpenAiClipGenerationConfig | null {
  if (environment.CLIP_GENERATION_ENABLED?.trim() !== "1") return null;
  const provider = environment.CLIP_GENERATION_PROVIDER?.trim() || "OPENAI";
  if (provider !== "OPENAI")
    throw new Error("CONFIG_CLIP_GENERATION_PROVIDER_UNSUPPORTED");
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.CLIP_GENERATION_MODEL?.trim();
  if (!apiKey) throw new Error("CONFIG_OPENAI_API_KEY_REQUIRED");
  if (!model) throw new Error("CONFIG_CLIP_GENERATION_MODEL_REQUIRED");
  const timeoutMs = integerFromEnvironment(
    environment,
    "CLIP_GENERATION_TIMEOUT_MS",
    120_000,
    5_000,
    600_000,
  );
  const baseUrl = environment.OPENAI_BASE_URL?.trim();
  return { apiKey, model, timeoutMs, ...(baseUrl ? { baseUrl } : {}) };
}

function integerFromEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = environment[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`CONFIG_${name}_INVALID`);
  return value;
}

export function tiktokPublishingConfig(
  environment: NodeJS.ProcessEnv,
): TikTokPublishingConfig | null {
  if (environment.TIKTOK_PUBLISHING_ENABLED?.trim() !== "1") return null;
  const clientKey = environment.TIKTOK_CLIENT_KEY?.trim();
  const clientSecret = environment.TIKTOK_CLIENT_SECRET?.trim();
  const rawCredentials = environment.TIKTOK_CHANNEL_CREDENTIALS_JSON?.trim();
  if (!clientKey) throw new Error("CONFIG_TIKTOK_CLIENT_KEY_REQUIRED");
  if (!clientSecret) throw new Error("CONFIG_TIKTOK_CLIENT_SECRET_REQUIRED");
  if (!rawCredentials)
    throw new Error("CONFIG_TIKTOK_CHANNEL_CREDENTIALS_JSON_REQUIRED");
  return {
    clientKey,
    clientSecret,
    credentials: parseChannelCredentials(rawCredentials, "TIKTOK"),
    ...publicationSessionKeyConfig(environment),
  };
}

export function youtubePublishingConfig(
  environment: NodeJS.ProcessEnv,
): YoutubePublishingConfig | null {
  if (environment.YOUTUBE_PUBLISHING_ENABLED?.trim() !== "1") return null;
  const clientId = environment.YOUTUBE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = environment.YOUTUBE_OAUTH_CLIENT_SECRET?.trim();
  const rawCredentials = environment.YOUTUBE_CHANNEL_CREDENTIALS_JSON?.trim();
  if (!clientId) throw new Error("CONFIG_YOUTUBE_OAUTH_CLIENT_ID_REQUIRED");
  if (!clientSecret)
    throw new Error("CONFIG_YOUTUBE_OAUTH_CLIENT_SECRET_REQUIRED");
  if (!rawCredentials)
    throw new Error("CONFIG_YOUTUBE_CHANNEL_CREDENTIALS_JSON_REQUIRED");
  const credentials = parseChannelCredentials(rawCredentials, "YOUTUBE");
  return {
    clientId,
    clientSecret,
    credentials,
    ...publicationSessionKeyConfig(environment),
  };
}

function parseChannelCredentials(
  serialized: string,
  provider: "YOUTUBE" | "TIKTOK",
): Array<{
  channelId?: string;
  externalChannelRef: string;
  refreshToken: string;
}> {
  const code = `CONFIG_${provider}_CHANNEL_CREDENTIALS_JSON_INVALID`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(code);
  }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error(code);
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error(code);
    const value = item as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          !["channelId", "externalChannelRef", "refreshToken"].includes(key),
      ) ||
      (value.channelId !== undefined && typeof value.channelId !== "string") ||
      typeof value.externalChannelRef !== "string" ||
      typeof value.refreshToken !== "string"
    )
      throw new Error(code);
    return {
      ...(typeof value.channelId === "string"
        ? { channelId: value.channelId }
        : {}),
      externalChannelRef: value.externalChannelRef,
      refreshToken: value.refreshToken,
    };
  });
}

export function publicationSessionKeyConfig(
  environment: NodeJS.ProcessEnv,
): PublicationSessionKeyConfig {
  const currentKeyVersion =
    environment.PUBLICATION_SESSION_CURRENT_KEY_VERSION?.trim();
  const serializedKeys = environment.PUBLICATION_SESSION_KEYS?.trim();
  if (!currentKeyVersion)
    throw new Error("CONFIG_PUBLICATION_SESSION_CURRENT_KEY_VERSION_REQUIRED");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(currentKeyVersion))
    throw new Error("CONFIG_PUBLICATION_SESSION_CURRENT_KEY_VERSION_INVALID");
  if (!serializedKeys)
    throw new Error("CONFIG_PUBLICATION_SESSION_KEYS_REQUIRED");

  const keys = new Map<string, Buffer>();
  for (const entry of serializedKeys.split(",")) {
    const separator = entry.indexOf(":");
    const version = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (
      separator < 1 ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(version) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(encoded) ||
      keys.has(version)
    )
      throw new Error("CONFIG_PUBLICATION_SESSION_KEYS_INVALID");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded)
      throw new Error("CONFIG_PUBLICATION_SESSION_KEYS_INVALID");
    keys.set(version, key);
  }
  if (!keys.has(currentKeyVersion))
    throw new Error("CONFIG_PUBLICATION_SESSION_CURRENT_KEY_MISSING");
  return { currentKeyVersion, keys };
}

export function resolveWorkerSourceAuthorizationPolicy(
  environment: NodeJS.ProcessEnv,
): "manual" | "local-auto" {
  const policy =
    environment.SOURCE_AUTHORIZATION_POLICY?.trim() === "local-auto"
      ? "local-auto"
      : "manual";
  if (policy === "manual") return policy;

  const localProfile = environment.DEPLOYMENT_PROFILE?.trim() === "local";
  const apiHost = environment.API_HOST?.trim() || "127.0.0.1";
  const loopback =
    apiHost === "127.0.0.1" || apiHost === "localhost" || apiHost === "::1";
  if (!localProfile || !loopback) {
    throw new Error("CONFIG_SOURCE_AUTHORIZATION_LOCAL_AUTO_UNSAFE");
  }
  return policy;
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
    frameExtractionCapacity: integer("FRAME_EXTRACTION_CAPACITY", 1, 1, 16),
    frameWorkDeadlineMs: integer(
      "FRAME_WORK_DEADLINE_MS",
      300_000,
      60_000,
      1_800_000,
    ),
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
    sourceCacheDirectory: resolve(
      process.env.MEDIA_SOURCE_CACHE_DIRECTORY?.trim() || "tmp/media-cache",
    ),
    sourceCacheMaxBytes:
      BigInt(integer("MEDIA_SOURCE_CACHE_MAX_MIB", 12_288, 64, 1_048_576)) *
      1024n *
      1024n,
    sourceCacheTtlMs: integer(
      "MEDIA_SOURCE_CACHE_TTL_MS",
      21_600_000,
      60_000,
      604_800_000,
    ),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH?.trim() || "ffprobe",
    ffmpegThreads: integer("FFMPEG_THREADS", 2, 1, 32),
    assemblyFontPath:
      process.env.ASSEMBLY_FONT_PATH?.trim() ||
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    sourceAuthorizationPolicy: resolveWorkerSourceAuthorizationPolicy(
      process.env,
    ),
  };
}
