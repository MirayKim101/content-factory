import { describe, expect, it, vi } from "vitest";

import { PgVerticalRenderRepository } from "../src/infrastructure/pg-vertical-render.repository.js";

const claim = {
  jobId: "00000000-0000-4000-8000-000000000001",
  intentId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  sourceId: "00000000-0000-4000-8000-000000000004",
  sourceVersion: 1,
  inputObjectKey: "cuts/input.mp4",
  inputSizeBytes: 5n,
  expectedDurationMs: 30_000,
  leaseToken: "lease-1",
  attemptNumber: 1,
  retryBudget: 2,
};

describe("PgVerticalRenderRepository", () => {
  it("keeps a prepared pending output marker when shutdown releases the lease", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('AS "preserveOutput"'))
        return { rowCount: 1, rows: [{ preserveOutput: true }] };
      return { rowCount: 1, rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const repository = new PgVerticalRenderRepository("postgresql://unused");
    Object.assign(repository as unknown as { pool: unknown }, { pool });

    await expect(repository.release(claim)).resolves.toBe(true);

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.startsWith("DELETE"))).toBe(false);
    expect(
      statements.some(
        (sql) =>
          sql.includes("VERTICAL_SHUTDOWN_AFTER_OUTPUT_PREPARED") &&
          sql.includes("\"cleanupStatus\"='PENDING'"),
      ),
    ).toBe(true);
    const pipelineUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE "PipelineJob"'),
    );
    expect(pipelineUpdate?.[1]).toEqual([claim.jobId, claim.leaseToken]);
    expect(String(pipelineUpdate?.[0])).toContain(
      'GREATEST("attemptCount"-1,0)',
    );
    expect(client.release).toHaveBeenCalledOnce();
  });
});
