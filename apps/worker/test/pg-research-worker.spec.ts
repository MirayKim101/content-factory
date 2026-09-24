import { describe, expect, it, vi } from "vitest";

import { PgResearchWorker } from "../src/infrastructure/pg-research-worker.js";

type FakeClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function client(selectResponses: unknown[][]): FakeClient {
  return {
    query: vi.fn(async (text: string) => {
      if (text.trimStart().startsWith("SELECT")) {
        return { rows: selectResponses.shift() ?? [] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function configuredWorker(
  clients: FakeClient[],
  sourceAuthorizationPolicy: "manual" | "local-auto" = "manual",
) {
  const worker = new PgResearchWorker(
    "postgresql://unused",
    sourceAuthorizationPolicy,
  );
  const pool = {
    connect: vi.fn(async () => {
      const next = clients.shift();
      if (!next) throw new Error("Unexpected database connection");
      return next;
    }),
    end: vi.fn(async () => undefined),
  };
  Object.assign(worker as unknown as { pool: unknown }, { pool });
  return { worker, pool };
}

const intentId = "00000000-0000-4000-8000-000000000001";

describe("PgResearchWorker durable delivery", () => {
  it("recovers queued and expired-lease intents from PostgreSQL after Redis loss", async () => {
    const worker = new PgResearchWorker("postgresql://unused", "manual");
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: intentId }],
    });
    const process = vi.spyOn(worker, "process").mockResolvedValue(undefined);
    Object.assign(worker as unknown as { pool: unknown }, {
      pool: { query, end: vi.fn() },
    });

    await expect(worker.recover(10)).resolves.toBe(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("leaseExpiresAt");
    expect(process).toHaveBeenCalledWith(intentId);
  });

  it("does not duplicate work while an active lease owns the intent", async () => {
    const claim = client([
      [
        {
          id: intentId,
          state: "PROCESSING",
          latestAttemptState: "PROCESSING",
          latestLeaseActive: true,
          attemptCount: 1,
        },
      ],
    ]);
    const { worker, pool } = configuredWorker([claim]);

    await worker.process(intentId);

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(claim.query.mock.calls.map(([sql]) => String(sql).trim())).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      expect.stringContaining('FROM "ResearchSuggestionIntent" i'),
      "ROLLBACK",
    ]);
  });

  it("passes the runtime rights policy into the claim lineage gate", async () => {
    const claim = client([
      [
        {
          id: intentId,
          state: "QUEUED",
          latestAttemptId: null,
          latestAttemptNumber: null,
          latestAttemptState: null,
          latestLeaseActive: false,
          attemptCount: 0,
        },
      ],
      [],
    ]);
    const { worker } = configuredWorker([claim], "manual");

    await worker.process(intentId);

    const lineageCall = claim.query.mock.calls.find(([sql]) =>
      String(sql).includes("LOCAL_DEVELOPMENT_AUTO"),
    );
    expect(lineageCall?.[1]).toEqual([intentId, "manual"]);
    expect(
      claim.query.mock.calls.some(([sql]) =>
        String(sql).includes("RESEARCH_CONTEXT_STALE"),
      ),
    ).toBe(true);
    expect(
      claim.query.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO "ResearchSuggestionAttempt"'),
      ),
    ).toBe(false);
  });

  it("creates one zero-cost authoritative suggestion after rechecking current lineage", async () => {
    const claim = client([
      [
        {
          id: intentId,
          state: "QUEUED",
          transcriptIntentId: "00000000-0000-4000-8000-000000000002",
          sourceContextRevisionId: "00000000-0000-4000-8000-000000000003",
          query: "topic",
          adapterVersion: "local-manual-research-v1",
          searchedAt: new Date(),
          freshUntil: new Date(Date.now() + 60_000),
          freshnessPolicyVersion: "research-freshness-24h-v1",
          latestAttemptId: null,
          latestAttemptNumber: null,
          latestAttemptState: null,
          latestLeaseActive: false,
          attemptCount: 0,
        },
      ],
      [{ current: true }],
      [{ sourceTitle: "Stream title" }],
      [
        {
          id: "00000000-0000-4000-8000-000000000004",
          url: "https://example.com/source",
          title: "Source",
          publisher: "Example",
          publishedAt: null,
          accessedAt: new Date(),
          excerpt: "Evidence",
          checksum: "a".repeat(64),
        },
      ],
    ]);
    const finalize: FakeClient = {
      query: vi.fn(async (text: string) => {
        if (text.includes('SELECT i."state", a."leaseToken"')) {
          const insert = claim.query.mock.calls.find(([sql]) =>
            String(sql).includes('INSERT INTO "ResearchSuggestionAttempt"'),
          );
          return {
            rows: [
              {
                state: "PROCESSING",
                leaseToken: insert?.[1]?.[3],
                leaseActive: true,
                deadlineActive: true,
              },
            ],
          };
        }
        if (text.includes("FOR SHARE OF")) return { rows: [{ id: intentId }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const { worker } = configuredWorker([claim, finalize]);

    await worker.process(intentId);

    const sql = finalize.query.mock.calls.map(([text]) => String(text));
    const finalizeLineageCall = finalize.query.mock.calls.find(([text]) =>
      String(text).includes("LOCAL_DEVELOPMENT_AUTO"),
    );
    expect(finalizeLineageCall?.[1]).toEqual([intentId, "manual"]);
    expect(
      sql.some((text) => text.includes('INSERT INTO "ResearchSuggestionSet"')),
    ).toBe(true);
    expect(sql.some((text) => text.includes("SET \"state\" = 'READY'"))).toBe(
      true,
    );
  });
});
