import { describe, expect, it, vi } from "vitest";

import { PgTranscriptWorker } from "../src/infrastructure/pg-transcript-worker.js";

type QueryCall = readonly [text: string, values?: readonly unknown[]];

type FakeClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function configuredWorker(clients: FakeClient[]) {
  const worker = new PgTranscriptWorker({
    databaseUrl: "postgresql://unused",
    bucket: "unused",
    storage: {
      endpoint: "http://unused",
      region: "unused",
      accessKey: "unused",
      secretKey: "unused",
    },
  });
  const pool = {
    connect: vi.fn(async () => {
      const client = clients.shift();
      if (!client) throw new Error("Unexpected database connection");
      return client;
    }),
    end: vi.fn(async () => undefined),
  };
  const storage = {
    send: vi.fn(async () => undefined),
    destroy: vi.fn(),
  };
  Object.assign(worker as unknown as { pool: unknown; storage: unknown }, {
    pool,
    storage,
  });
  return { worker, pool, storage };
}

function client(responses: Array<{ rows: unknown[] } | Error> = []): FakeClient {
  return {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.startsWith("SELECT i.\"id\"")) {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response ?? { rows: [] };
      }
      if (text.includes('SELECT i."state", a."leaseToken"')) {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response ?? { rows: [] };
      }
      return { rows: [], text, values };
    }),
    release: vi.fn(),
  };
}

function calls(fake: FakeClient): QueryCall[] {
  return fake.query.mock.calls as unknown as QueryCall[];
}

const intentId = "00000000-0000-4000-8000-000000000001";

describe("PgTranscriptWorker fencing and retry boundaries", () => {
  it("does not create another attempt while a non-expired attempt owns the intent", async () => {
    const claim = client([
      {
        rows: [
          {
            id: intentId,
            state: "PROCESSING",
            fixture: { language: "ru", segments: [] },
            cutStartMs: 0,
            cutEndMs: 1_000,
            attemptCount: 1,
            retryBudget: 2,
            attemptState: "PROCESSING",
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        ],
      },
    ]);
    const { worker, pool, storage } = configuredWorker([claim]);

    await worker.process(intentId);

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(storage.send).not.toHaveBeenCalled();
    expect(claim.release).toHaveBeenCalledOnce();
    expect(calls(claim).map(([text]) => text.trim())).toEqual([
      "BEGIN",
      expect.stringContaining('FROM "TranscriptEvidenceIntent" i'),
      "ROLLBACK",
    ]);
    expect(calls(claim).some(([text]) => text.includes('INSERT INTO "TranscriptEvidenceAttempt"'))).toBe(false);
  });

  it("rejects a late completion whose lease token was replaced without changing terminal state", async () => {
    const claim = client([
      {
        rows: [
          {
            id: intentId,
            state: "QUEUED",
            fixture: {
              language: "ru",
              segments: [{ ordinal: 0, startMs: 0, endMs: 900, text: "Тест" }],
            },
            cutStartMs: 0,
            cutEndMs: 1_000,
            attemptCount: 0,
            retryBudget: 1,
            attemptState: null,
            leaseExpiresAt: new Date(0),
          },
        ],
      },
    ]);
    const finalize = client([
      {
        rows: [
          {
            state: "FAILED_FINAL",
            leaseToken: "replacement-lease-token",
            workDeadlineAt: new Date(Date.now() + 60_000),
          },
        ],
      },
    ]);
    const { worker, storage } = configuredWorker([claim, finalize]);

    await worker.process(intentId);

    expect(storage.send).toHaveBeenCalledOnce();
    expect(finalize.release).toHaveBeenCalledOnce();
    expect(calls(finalize).map(([text]) => text.trim())).toEqual([
      "BEGIN",
      expect.stringContaining('WHERE i."id" = $1 AND a."id" = $2 FOR UPDATE'),
      "ROLLBACK",
    ]);
    expect(calls(finalize).some(([text]) => text.includes('INSERT INTO "TranscriptEvidenceArtifact"'))).toBe(false);
    expect(calls(finalize).some(([text]) => text.includes("SET \"state\" = 'READY'"))).toBe(false);
  });

  it("keeps an exhausted delivery failure terminal instead of re-queueing it", async () => {
    const claim = client([
      {
        rows: [
          {
            id: intentId,
            state: "QUEUED",
            fixture: {
              language: "ru",
              segments: [{ ordinal: 0, startMs: 0, endMs: 900, text: "Тест" }],
            },
            cutStartMs: 0,
            cutEndMs: 1_000,
            attemptCount: 1,
            retryBudget: 1,
            attemptState: "FAILED_FINAL",
            leaseExpiresAt: new Date(0),
          },
        ],
      },
    ]);
    const failed = client();
    const { worker, storage } = configuredWorker([claim, failed]);
    storage.send.mockRejectedValueOnce(new Error("S3 unavailable"));

    await expect(worker.process(intentId)).rejects.toThrow("S3 unavailable");

    const failureUpdate = calls(failed).find(([text]) =>
      text.includes('UPDATE "TranscriptEvidenceIntent"'),
    );
    expect(failureUpdate?.[0]).toContain(
      `CASE WHEN "attemptCount" <= "retryBudget" THEN 'QUEUED' ELSE 'FAILED_FINAL' END`,
    );
    expect(failureUpdate?.[0]).toContain(
      `WHERE "id" = $3 AND "state" = 'PROCESSING'`,
    );
    expect(failureUpdate?.[1]).toEqual([
      expect.any(String),
      "TRANSCRIPT_DELIVERY_FAILED",
      intentId,
    ]);
    expect(failed.release).toHaveBeenCalledOnce();
  });
});
