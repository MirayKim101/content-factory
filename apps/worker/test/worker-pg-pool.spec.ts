import { describe, expect, it } from "vitest";

import {
  WORKER_PG_CONNECTION_TIMEOUT_MS,
  WORKER_PG_QUERY_TIMEOUT_MS,
  workerPgPoolConfig,
} from "../src/infrastructure/worker-pg-pool.js";

describe("workerPgPoolConfig", () => {
  it("bounds connection, query, statement, and idle transaction waits", () => {
    expect(workerPgPoolConfig("postgres://worker", 4)).toEqual({
      connectionString: "postgres://worker",
      max: 4,
      connectionTimeoutMillis: WORKER_PG_CONNECTION_TIMEOUT_MS,
      query_timeout: WORKER_PG_QUERY_TIMEOUT_MS,
      statement_timeout: WORKER_PG_QUERY_TIMEOUT_MS,
      idle_in_transaction_session_timeout: WORKER_PG_QUERY_TIMEOUT_MS,
      keepAlive: true,
    });
  });
});
