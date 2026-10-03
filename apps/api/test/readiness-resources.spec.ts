import { describe, expect, it } from "vitest";

import { READINESS_NETWORK_TIMEOUT_MS } from "../src/readiness/readiness.constants.js";
import { readinessPostgresPoolConfig } from "../src/readiness/readiness.resources.js";

describe("readiness resource configuration", () => {
  it("uses one separately bounded read-only PostgreSQL pool", () => {
    expect(
      readinessPostgresPoolConfig("postgresql://readiness.example/database"),
    ).toMatchObject({
      connectionString: "postgresql://readiness.example/database",
      max: 1,
      options: "-c default_transaction_read_only=on",
      connectionTimeoutMillis: READINESS_NETWORK_TIMEOUT_MS,
      query_timeout: READINESS_NETWORK_TIMEOUT_MS,
      statement_timeout: READINESS_NETWORK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: READINESS_NETWORK_TIMEOUT_MS,
    });
  });
});
