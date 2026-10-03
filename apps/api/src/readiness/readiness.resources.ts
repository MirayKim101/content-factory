import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { RedisConnection } from "bullmq";
import { Injectable } from "@nestjs/common";
import { Pool, type PoolConfig } from "pg";

import { apiEnvironment, databaseUrl } from "../config/environment.js";
import { READINESS_NETWORK_TIMEOUT_MS } from "./readiness.constants.js";

export interface ReadinessPostgresClient {
  query(query: string): Promise<unknown>;
  release(error?: Error): void;
}

export interface ReadinessPostgresPool {
  connect(): Promise<ReadinessPostgresClient>;
  end(): Promise<void>;
}

export interface ReadinessRedisClient {
  info(): Promise<string>;
}

export interface ReadinessRedisConnection {
  readonly client: Promise<ReadinessRedisClient>;
  close(force?: boolean): Promise<void>;
}

export interface ReadinessS3Client {
  send(
    command: HeadBucketCommand,
    options: { abortSignal: AbortSignal },
  ): Promise<unknown>;
  destroy(): void;
}

export interface ReadinessResources {
  postgres: ReadinessPostgresPool;
  redis: ReadinessRedisConnection;
  s3: ReadinessS3Client;
  sourceBucket: string;
}

export const READINESS_RESOURCE_FACTORY = Symbol("READINESS_RESOURCE_FACTORY");

export interface ReadinessResourceFactoryPort {
  create(): ReadinessResources;
}

export function readinessPostgresPoolConfig(
  connectionString: string,
): PoolConfig {
  return {
    connectionString,
    max: 1,
    options: "-c default_transaction_read_only=on",
    connectionTimeoutMillis: READINESS_NETWORK_TIMEOUT_MS,
    query_timeout: READINESS_NETWORK_TIMEOUT_MS,
    statement_timeout: READINESS_NETWORK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: READINESS_NETWORK_TIMEOUT_MS,
    idleTimeoutMillis: READINESS_NETWORK_TIMEOUT_MS,
  };
}

export function createReadinessRedisConnection(options: {
  host: string;
  port: number;
  password: string;
}): ReadinessRedisConnection {
  const connection = new RedisConnection(
    {
      host: options.host,
      port: options.port,
      password: options.password,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: READINESS_NETWORK_TIMEOUT_MS,
      commandTimeout: READINESS_NETWORK_TIMEOUT_MS,
      retryStrategy: () => null,
    },
    { blocking: false, skipVersionCheck: true },
  );
  connection.on("error", () => undefined);
  return connection;
}

@Injectable()
export class ReadinessResourceFactory implements ReadinessResourceFactoryPort {
  create(): ReadinessResources {
    const config = apiEnvironment();
    const postgres = new Pool(readinessPostgresPoolConfig(databaseUrl()));
    let redis: ReadinessRedisConnection | undefined;
    let s3: S3Client | undefined;

    try {
      redis = createReadinessRedisConnection({
        host: config.redisHost,
        port: config.redisPort,
        password: config.redisPassword,
      });
      s3 = new S3Client({
        endpoint: config.s3Endpoint,
        region: config.s3Region,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.s3AccessKey,
          secretAccessKey: config.s3SecretKey,
        },
        maxAttempts: 1,
      });
      return { postgres, redis, s3, sourceBucket: config.sourceBucket };
    } catch (error) {
      disposePartiallyCreatedResources(postgres, redis, s3);
      throw error;
    }
  }
}

function disposePartiallyCreatedResources(
  postgres: ReadinessPostgresPool,
  redis: ReadinessRedisConnection | undefined,
  s3: ReadinessS3Client | undefined,
): void {
  try {
    s3?.destroy();
  } catch {
    // Continue closing the remaining dedicated readiness resources.
  }
  try {
    void postgres.end().catch(() => undefined);
  } catch {
    // The factory is already failing; do not replace its original error.
  }
  try {
    void redis?.close(true).catch(() => undefined);
  } catch {
    // The factory is already failing; do not replace its original error.
  }
}
