import type { PoolConfig } from "pg";

export const WORKER_PG_CONNECTION_TIMEOUT_MS = 5_000;
export const WORKER_PG_QUERY_TIMEOUT_MS = 30_000;

export function workerPgPoolConfig(
  connectionString: string,
  max: number,
): PoolConfig {
  return {
    connectionString,
    max,
    connectionTimeoutMillis: WORKER_PG_CONNECTION_TIMEOUT_MS,
    query_timeout: WORKER_PG_QUERY_TIMEOUT_MS,
    statement_timeout: WORKER_PG_QUERY_TIMEOUT_MS,
    idle_in_transaction_session_timeout: WORKER_PG_QUERY_TIMEOUT_MS,
    keepAlive: true,
  };
}
