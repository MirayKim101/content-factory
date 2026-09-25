import { describe, expect, it, vi } from "vitest";

import { PgTranscriptWorker } from "../src/infrastructure/pg-transcript-worker.js";

type QueryCall = readonly [text: string, values?: readonly unknown[]];

type FakeClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

let latestLeaseToken = "";
let latestCleanupLeaseToken = "";

function configuredWorker(
  clients: FakeClient[],
  options: {
    accepted?: boolean;
    acceptedError?: Error;
    dueAttemptIds?: string[];
    skipDueRecoveryCalls?: number;
  } = {},
) {
  let recoveryQueryCount = 0;
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
    query: vi.fn(async (text: string) => {
      if (text.includes('"TranscriptEvidenceArtifact" ar')) {
        if (options.acceptedError) throw options.acceptedError;
        return {
          rows: options.accepted ? [{ accepted: 1 }] : [],
          rowCount: options.accepted ? 1 : 0,
        };
      }
      if (text.includes('FROM "TranscriptEvidenceAttempt"')) {
        recoveryQueryCount += 1;
        const rows =
          recoveryQueryCount > (options.skipDueRecoveryCalls ?? 0)
            ? (options.dueAttemptIds ?? []).map((id) => ({ id }))
            : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    }),
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

function client(
  responses: Array<{ rows: unknown[]; rowCount?: number } | Error> = [],
  overrides: Array<{
    contains: string;
    rowCount?: number;
    error?: Error;
  }> = [],
): FakeClient {
  return {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.includes('INSERT INTO "TranscriptEvidenceAttempt"')) {
        latestLeaseToken = String(values?.[4]);
      }
      if (text.includes('SET "cleanupLeaseToken" = $2')) {
        latestCleanupLeaseToken = String(values?.[1]);
      }
      if (text.startsWith('SELECT i."id"')) {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response ?? { rows: [] };
      }
      if (text.includes('SELECT i."state", a."leaseToken"')) {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        if (response) {
          response.rows = response.rows.map((row) => {
            if (
              row &&
              typeof row === "object" &&
              "leaseToken" in row &&
              typeof row.leaseToken !== "string"
            )
              return { ...row, leaseToken: latestLeaseToken };
            return row;
          });
        }
        return response ?? { rows: [] };
      }
      if (text.includes('SELECT a."objectKey", a."cleanupStatus"')) {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response ?? { rows: [] };
      }
      const override = overrides.find(({ contains }) =>
        text.includes(contains),
      );
      if (override?.error) throw override.error;
      if (override?.rowCount !== undefined)
        return { rows: [], rowCount: override.rowCount, text, values };
      return { rows: [], rowCount: 1, text, values };
    }),
    release: vi.fn(),
  };
}

function cleanupClient(
  overrides: Partial<{
    cleanupStatus: string;
    uploadStarted: boolean;
    uploadSettled: boolean;
    attemptState: string;
    intentState: string;
    currentAttempt: boolean;
    leaseActive: boolean;
    graceElapsed: boolean;
    artifactId: string | null;
  }> = {},
): FakeClient {
  const fake = client();
  fake.query.mockImplementation(
    async (text: string, values?: readonly unknown[]) => {
      if (text.includes('SET "cleanupLeaseToken" = $2')) {
        latestCleanupLeaseToken = String(values?.[1]);
      }
      if (text.includes('SELECT a."objectKey", a."cleanupStatus"')) {
        const attemptId = String(values?.[0]);
        return {
          rows: [
            {
              objectKey: `ai-content/transcripts/${intentId}/attempts/${attemptId}/transcript.json`,
              cleanupStatus: "PENDING",
              uploadStarted: true,
              uploadSettled: true,
              attemptState: "FAILED_FINAL",
              intentState: "FAILED_FINAL",
              currentAttempt: true,
              leaseActive: false,
              graceElapsed: false,
              artifactId: null,
              ...overrides,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1, text, values };
    },
  );
  return fake;
}

function finishCleanupClient(artifactId: string | null = null): FakeClient {
  const fake = client();
  fake.query.mockImplementation(
    async (text: string, values?: readonly unknown[]) => {
      if (text.includes('SELECT a."cleanupStatus", a."cleanupLeaseToken"')) {
        return {
          rows: [
            {
              cleanupStatus: "PENDING",
              cleanupLeaseToken: latestCleanupLeaseToken,
              artifactId,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1, text, values };
    },
  );
  return fake;
}

function calls(fake: FakeClient): QueryCall[] {
  return fake.query.mock.calls as unknown as QueryCall[];
}

const intentId = "00000000-0000-4000-8000-000000000001";

function deliveryWithLostCommit(): [FakeClient, FakeClient] {
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
          sourceVersion: 1,
          sourceSha256: "a".repeat(64),
          sourceAuthorizationRevision: 1,
          cutPipelineJobId: "00000000-0000-4000-8000-000000000002",
          cutResultArtifactId: "00000000-0000-4000-8000-000000000003",
          cutResultSha256: "b".repeat(64),
          cutResultSizeBytes: "10",
          creatorProfileRevisionId: "00000000-0000-4000-8000-000000000004",
          creatorProfileRevisionNo: 1,
          sourceContextRevisionId: "00000000-0000-4000-8000-000000000005",
          sourceContextRevisionNo: 1,
          cutPromptRevisionId: "00000000-0000-4000-8000-000000000006",
          cutPromptRevisionNo: 1,
          attemptCount: 0,
          retryBudget: 1,
          attemptState: null,
          leaseActive: false,
        },
      ],
    },
  ]);
  const finalize = client(
    [
      {
        rows: [
          {
            state: "PROCESSING",
            leaseToken: expect.any(String),
            leaseActive: true,
            deadlineActive: true,
          },
        ],
      },
    ],
    [{ contains: "COMMIT", error: new Error("commit acknowledgement lost") }],
  );
  return [claim, finalize];
}

describe("PgTranscriptWorker fencing and retry boundaries", () => {
  it("never deletes the object of an active current lease during periodic recovery", async () => {
    const attemptId = "00000000-0000-4000-8000-000000000010";
    const cleanup = cleanupClient({
      attemptState: "PROCESSING",
      intentState: "PROCESSING",
      currentAttempt: true,
      leaseActive: true,
      uploadStarted: true,
      uploadSettled: true,
    });
    const { worker, storage } = configuredWorker([cleanup], {
      dueAttemptIds: [attemptId],
    });

    await expect(worker.recover()).resolves.toBe(1);

    expect(storage.send).not.toHaveBeenCalled();
    const deferred = calls(cleanup).find(([text]) =>
      text.includes('SET "cleanupLastErrorCode" = $2'),
    );
    expect(deferred?.[1]).toEqual([
      attemptId,
      "TRANSCRIPT_CLEANUP_ACTIVE_LEASE",
    ]);
  });

  it("never deletes a non-current PROCESSING attempt while its lease is active", async () => {
    const attemptId = "00000000-0000-4000-8000-000000000012";
    const cleanup = cleanupClient({
      attemptState: "PROCESSING",
      intentState: "QUEUED",
      currentAttempt: false,
      leaseActive: true,
    });
    const { worker, storage } = configuredWorker([cleanup], {
      dueAttemptIds: [attemptId],
    });

    await expect(worker.recover()).resolves.toBe(1);

    expect(storage.send).not.toHaveBeenCalled();
    expect(
      calls(cleanup).some(([, values]) =>
        values?.includes("TRANSCRIPT_CLEANUP_ACTIVE_LEASE"),
      ),
    ).toBe(true);
  });

  it("fails closed when any artifact row already references the exact object key", async () => {
    const attemptId = "00000000-0000-4000-8000-000000000013";
    const cleanup = cleanupClient({
      intentState: "FAILED_FINAL",
      attemptState: "FAILED_FINAL",
      artifactId: "00000000-0000-4000-8000-000000000099",
    });
    const { worker, storage } = configuredWorker([cleanup], {
      dueAttemptIds: [attemptId],
    });

    await expect(worker.recover()).resolves.toBe(1);

    expect(storage.send).not.toHaveBeenCalled();
    expect(
      calls(cleanup).some(([text]) =>
        text.includes("\"cleanupStatus\" = 'NOT_REQUIRED'"),
      ),
    ).toBe(true);
  });

  it("keeps durable cleanup pending after delete failure and retries it", async () => {
    const attemptId = "00000000-0000-4000-8000-000000000011";
    const firstCleanup = cleanupClient();
    const firstFinish = finishCleanupClient();
    const retryCleanup = cleanupClient();
    const retryFinish = finishCleanupClient();
    const { worker, storage } = configuredWorker(
      [firstCleanup, firstFinish, retryCleanup, retryFinish],
      { dueAttemptIds: [attemptId] },
    );
    storage.send.mockRejectedValueOnce(new Error("temporary delete failure"));

    await expect(worker.recover()).resolves.toBe(1);
    await expect(worker.recover()).resolves.toBe(1);

    expect(storage.send).toHaveBeenCalledTimes(2);
    const firstReservationCommit =
      firstCleanup.query.mock.invocationCallOrder[
        calls(firstCleanup).findIndex(([text]) => text === "COMMIT")
      ]!;
    const firstDelete = storage.send.mock.invocationCallOrder[0]!;
    const firstFinalReread = firstFinish.query.mock.invocationCallOrder[1]!;
    expect(firstReservationCommit).toBeLessThan(firstDelete);
    expect(firstDelete).toBeLessThan(firstFinalReread);
    expect(
      calls(firstFinish).some(([text]) =>
        text.includes("TRANSCRIPT_OBJECT_DELETE_FAILED"),
      ),
    ).toBe(true);
    expect(
      calls(retryFinish).some(([text]) =>
        text.includes("\"cleanupStatus\" = 'COMPLETED'"),
      ),
    ).toBe(true);
  });

  it("keeps a recurring tombstone after deleting an unsettled PUT key past grace", async () => {
    const attemptId = "00000000-0000-4000-8000-000000000014";
    const cleanup = cleanupClient({
      uploadStarted: true,
      uploadSettled: false,
      attemptState: "FAILED_FINAL",
      leaseActive: false,
      graceElapsed: true,
    });
    const finishCleanup = finishCleanupClient();
    const { worker, storage } = configuredWorker([cleanup, finishCleanup], {
      dueAttemptIds: [attemptId],
    });

    await expect(worker.recover()).resolves.toBe(1);

    expect(storage.send).toHaveBeenCalledOnce();
    expect(
      calls(finishCleanup).some(([text]) =>
        text.includes("TRANSCRIPT_UPLOAD_OUTCOME_UNKNOWN"),
      ),
    ).toBe(true);
    expect(
      calls(finishCleanup).some(([text]) =>
        text.includes("\"cleanupStatus\" = 'COMPLETED'"),
      ),
    ).toBe(false);
  });

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
            leaseActive: true,
            leaseExpiresAt: new Date(0),
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
    expect(
      calls(claim).some(([text]) =>
        text.includes('INSERT INTO "TranscriptEvidenceAttempt"'),
      ),
    ).toBe(false);
  });

  it("does not claim a retry when the database expiry fence loses the race", async () => {
    const claim = client(
      [
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
              leaseActive: false,
            },
          ],
        },
      ],
      [{ contains: "TRANSCRIPT_LEASE_EXPIRED", rowCount: 0 }],
    );
    const { worker, pool, storage } = configuredWorker([claim]);

    await worker.process(intentId);

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(storage.send).not.toHaveBeenCalled();
    expect(
      calls(claim).some(([text]) =>
        text.includes('INSERT INTO "TranscriptEvidenceAttempt"'),
      ),
    ).toBe(false);
    expect(calls(claim).at(-1)?.[0]).toBe("ROLLBACK");
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
            leaseActive: false,
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
            leaseActive: true,
            deadlineActive: true,
          },
        ],
      },
    ]);
    const cleanup = cleanupClient();
    const finishCleanup = finishCleanupClient();
    const { worker, storage } = configuredWorker([
      claim,
      finalize,
      cleanup,
      finishCleanup,
    ]);

    await worker.process(intentId);

    expect(storage.send).toHaveBeenCalledTimes(2);
    const storageCalls = storage.send.mock.calls as unknown as Array<
      [{ constructor: { name: string } }]
    >;
    expect(storageCalls[1]?.[0].constructor.name).toBe("DeleteObjectCommand");
    expect(finalize.release).toHaveBeenCalledOnce();
    expect(calls(finalize).map(([text]) => text.trim())).toEqual([
      "BEGIN",
      expect.stringContaining(
        'WHERE i."id" = $1 AND a."id" = $2\n              AND a."attemptNumber" = i."attemptCount" FOR UPDATE',
      ),
      "ROLLBACK",
    ]);
    expect(
      calls(finalize).some(([text]) =>
        text.includes('INSERT INTO "TranscriptEvidenceArtifact"'),
      ),
    ).toBe(false);
    expect(
      calls(finalize).some(([text]) =>
        text.includes("SET \"state\" = 'READY'"),
      ),
    ).toBe(false);
  });

  it("rejects and removes an uploaded artifact when the database lease expires before finalization", async () => {
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
            leaseActive: false,
          },
        ],
      },
    ]);
    const finalize = client([
      {
        rows: [
          {
            state: "PROCESSING",
            leaseToken: expect.any(String),
            leaseActive: false,
            deadlineActive: true,
          },
        ],
      },
    ]);
    const cleanup = cleanupClient();
    const finishCleanup = finishCleanupClient();
    const { worker, storage } = configuredWorker([
      claim,
      finalize,
      cleanup,
      finishCleanup,
    ]);

    await worker.process(intentId);

    expect(storage.send).toHaveBeenCalledTimes(2);
    const storageCalls = storage.send.mock.calls as unknown as Array<
      [{ constructor: { name: string }; input?: { Key?: string } }]
    >;
    const put = storageCalls[0]![0];
    const remove = storageCalls[1]![0];
    expect(put.constructor.name).toBe("PutObjectCommand");
    expect(remove.constructor.name).toBe("DeleteObjectCommand");
    expect(put.input?.Key).toMatch(
      new RegExp(
        `^ai-content/transcripts/${intentId}/attempts/.+/transcript\\.json$`,
      ),
    );
    expect(remove.input?.Key).toBe(put.input?.Key);
    expect(
      calls(finalize).some(([text]) =>
        text.includes('INSERT INTO "TranscriptEvidenceArtifact"'),
      ),
    ).toBe(false);
  });

  it("preserves the accepted object when COMMIT succeeds but its acknowledgement is lost", async () => {
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
            sourceVersion: 1,
            sourceSha256: "a".repeat(64),
            sourceAuthorizationRevision: 1,
            cutPipelineJobId: "00000000-0000-4000-8000-000000000002",
            cutResultArtifactId: "00000000-0000-4000-8000-000000000003",
            cutResultSha256: "b".repeat(64),
            cutResultSizeBytes: "10",
            creatorProfileRevisionId: "00000000-0000-4000-8000-000000000004",
            creatorProfileRevisionNo: 1,
            sourceContextRevisionId: "00000000-0000-4000-8000-000000000005",
            sourceContextRevisionNo: 1,
            cutPromptRevisionId: "00000000-0000-4000-8000-000000000006",
            cutPromptRevisionNo: 1,
            attemptCount: 0,
            retryBudget: 1,
            attemptState: null,
            leaseActive: false,
          },
        ],
      },
    ]);
    const finalize = client(
      [
        {
          rows: [
            {
              state: "PROCESSING",
              leaseToken: expect.any(String),
              leaseActive: true,
              deadlineActive: true,
            },
          ],
        },
      ],
      [{ contains: "COMMIT", error: new Error("commit acknowledgement lost") }],
    );
    const { worker, pool, storage } = configuredWorker([claim, finalize], {
      accepted: true,
    });

    await worker.process(intentId);

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(storage.send).toHaveBeenCalledOnce();
    const storageCalls = storage.send.mock.calls as unknown as Array<
      [{ constructor: { name: string } }]
    >;
    expect(storageCalls[0]?.[0].constructor.name).toBe("PutObjectCommand");
    expect(
      calls(finalize).some(([text]) =>
        text.includes("SET \"state\" = 'READY'"),
      ),
    ).toBe(true);
  });

  it("does not delete or write failure state when ambiguous-COMMIT reread is unavailable", async () => {
    const [claim, finalize] = deliveryWithLostCommit();
    const { worker, pool, storage } = configuredWorker([claim, finalize], {
      acceptedError: new Error("database unavailable during reconciliation"),
    });

    await expect(worker.process(intentId)).rejects.toThrow(
      "TRANSCRIPT_DELIVERY_OUTCOME_UNKNOWN",
    );

    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(storage.send).toHaveBeenCalledOnce();
    expect(
      calls(finalize).some(([text]) =>
        text.includes("\"failureCode\" = 'TRANSCRIPT_DELIVERY_FAILED'"),
      ),
    ).toBe(false);
  });

  it("aborts a hanging PUT before lease expiry and only then cleans its object key", async () => {
    vi.useFakeTimers();
    try {
      const [claim] = deliveryWithLostCommit();
      const failed = client();
      const immediateCleanup = cleanupClient({ uploadSettled: false });
      const graceCleanup1 = cleanupClient({
        uploadSettled: false,
        graceElapsed: true,
      });
      const finishCleanup1 = finishCleanupClient();
      const graceCleanup2 = cleanupClient({
        uploadSettled: false,
        graceElapsed: true,
      });
      const finishCleanup2 = finishCleanupClient();
      const { worker, storage } = configuredWorker(
        [
          claim,
          failed,
          immediateCleanup,
          graceCleanup1,
          finishCleanup1,
          graceCleanup2,
          finishCleanup2,
        ],
        {
          dueAttemptIds: ["00000000-0000-4000-8000-000000000015"],
          skipDueRecoveryCalls: 1,
        },
      );
      storage.send.mockImplementationOnce(
        async (...args: unknown[]) =>
          new Promise<undefined>((_resolve, reject) => {
            const options = args[1] as
              { abortSignal?: AbortSignal } | undefined;
            options?.abortSignal?.addEventListener(
              "abort",
              () => reject(new Error("upload aborted")),
              { once: true },
            );
          }),
      );

      const processing = expect(worker.process(intentId)).rejects.toThrow(
        "upload aborted",
      );
      await vi.advanceTimersByTimeAsync(25_000);
      await processing;
      await worker.recover();
      await worker.recover();

      expect(storage.send).toHaveBeenCalledTimes(3);
      const storageCalls = storage.send.mock.calls as unknown as Array<
        [unknown, { abortSignal?: AbortSignal }?]
      >;
      expect(storageCalls[0]?.[1]?.abortSignal?.aborted).toBe(true);
      expect(
        [...calls(finishCleanup1), ...calls(finishCleanup2)].filter(([text]) =>
          text.includes("TRANSCRIPT_UPLOAD_OUTCOME_UNKNOWN"),
        ),
      ).toHaveLength(2);
      expect(
        [...calls(finishCleanup1), ...calls(finishCleanup2)].some(([text]) =>
          text.includes("\"cleanupStatus\" = 'COMPLETED'"),
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records an expired attempt before a restarted worker claims the retry", async () => {
    const claim = client([
      {
        rows: [
          {
            id: intentId,
            state: "PROCESSING",
            fixture: {
              language: "ru",
              segments: [{ ordinal: 0, startMs: 0, endMs: 900, text: "Тест" }],
            },
            cutStartMs: 0,
            cutEndMs: 1_000,
            sourceVersion: 1,
            sourceSha256: "a".repeat(64),
            sourceAuthorizationRevision: 1,
            cutPipelineJobId: "00000000-0000-4000-8000-000000000002",
            cutResultArtifactId: "00000000-0000-4000-8000-000000000003",
            cutResultSha256: "b".repeat(64),
            cutResultSizeBytes: "10",
            creatorProfileRevisionId: "00000000-0000-4000-8000-000000000004",
            creatorProfileRevisionNo: 1,
            sourceContextRevisionId: "00000000-0000-4000-8000-000000000005",
            sourceContextRevisionNo: 1,
            cutPromptRevisionId: "00000000-0000-4000-8000-000000000006",
            cutPromptRevisionNo: 1,
            attemptCount: 1,
            retryBudget: 1,
            attemptState: "PROCESSING",
            leaseActive: false,
          },
        ],
      },
    ]);
    const finalize = client([
      {
        rows: [
          {
            state: "PROCESSING",
            leaseToken: expect.any(String),
            leaseActive: true,
            deadlineActive: true,
          },
        ],
      },
      { rows: [{ accepted: 1 }] },
    ]);
    const { worker } = configuredWorker([claim, finalize]);

    await worker.process(intentId);

    const claimSql = calls(claim).map(([text]) => text);
    expect(claimSql).toEqual(
      expect.arrayContaining([
        expect.stringContaining('UPDATE "TranscriptEvidenceAttempt"'),
        expect.stringContaining('INSERT INTO "TranscriptEvidenceAttempt"'),
      ]),
    );
    const expiredUpdate = calls(claim).find(([text]) =>
      text.includes("TRANSCRIPT_LEASE_EXPIRED"),
    );
    expect(expiredUpdate?.[1]).toEqual([intentId, 1]);
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
            leaseActive: false,
          },
        ],
      },
    ]);
    const failed = client();
    const cleanup = cleanupClient({ uploadSettled: false });
    const { worker, storage } = configuredWorker([claim, failed, cleanup]);
    storage.send.mockRejectedValueOnce(new Error("S3 unavailable"));

    await expect(worker.process(intentId)).rejects.toThrow("S3 unavailable");

    expect(storage.send).toHaveBeenCalledOnce();
    expect(
      calls(cleanup).some(([, values]) =>
        values?.includes("TRANSCRIPT_UPLOAD_OUTCOME_UNKNOWN"),
      ),
    ).toBe(true);

    const failureUpdate = calls(failed).find(([text]) =>
      text.includes('UPDATE "TranscriptEvidenceIntent"'),
    );
    expect(failureUpdate?.[0]).toContain(
      `THEN 'QUEUED'::"TranscriptIntentState"`,
    );
    expect(failureUpdate?.[0]).toContain(
      `ELSE 'FAILED_FINAL'::"TranscriptIntentState" END`,
    );
    expect(failureUpdate?.[1]).toEqual([intentId, 2]);
    const attemptFailureUpdate = calls(failed).find(([text]) =>
      text.includes('UPDATE "TranscriptEvidenceAttempt"'),
    );
    expect(attemptFailureUpdate?.[0]).toContain(
      `WHERE "id" = $1 AND "leaseToken" = $2 AND "state" = 'PROCESSING'`,
    );
    expect(attemptFailureUpdate?.[1]).toEqual([
      expect.any(String),
      expect.any(String),
      "TRANSCRIPT_DELIVERY_FAILED",
      intentId,
    ]);
    expect(failed.release).toHaveBeenCalledOnce();
  });
});
