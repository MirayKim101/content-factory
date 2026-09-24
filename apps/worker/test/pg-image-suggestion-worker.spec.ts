import { describe, expect, it, vi } from "vitest";

import { PgImageSuggestionWorker } from "../src/infrastructure/pg-image-suggestion-worker.js";

type FakeClient = { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
type TestStorage = {
  uploadBytes: ReturnType<typeof vi.fn<(input: { objectKey: string; bytes: Buffer; contentType: string; sha256: string }) => Promise<{ etag: string }>>>;
  delete: ReturnType<typeof vi.fn<(objectKey: string) => Promise<void>>>;
};
const intentId = "00000000-0000-4000-8000-000000000001";

function storage(): TestStorage {
  return {
    uploadBytes: vi.fn(async (_input: { objectKey: string; bytes: Buffer; contentType: string; sha256: string }) => ({ etag: "etag" })),
    delete: vi.fn(async (_objectKey: string) => undefined),
  };
}

function configured(clients: FakeClient[], objectStorage: TestStorage = storage()) {
  const worker = new PgImageSuggestionWorker("postgresql://unused", "manual", objectStorage);
  const pool = { connect: vi.fn(async () => {
    const next = clients.shift(); if (!next) throw new Error("Unexpected database connection"); return next;
  }), query: vi.fn(async (sql: string) => ({ rowCount: sql.includes('SET "uploadStartedAt"') ? 1 : 0, rows: [] })), end: vi.fn(async () => undefined) };
  Object.assign(worker as unknown as { pool: unknown }, { pool });
  return { worker, pool, objectStorage };
}

describe("PgImageSuggestionWorker", () => {
  it("recovers PostgreSQL-owned work after Redis delivery loss", async () => {
    const objectStorage = storage();
    const worker = new PgImageSuggestionWorker("postgresql://unused", "manual", objectStorage);
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('a."state"=\'FAILED_FINAL\'') ? [] : [{ id: intentId }] }));
    const process = vi.spyOn(worker, "process").mockResolvedValue(undefined);
    Object.assign(worker as unknown as { pool: unknown }, { pool: { query, end: vi.fn() } });
    await expect(worker.recover()).resolves.toBe(1);
    expect(process).toHaveBeenCalledWith(intentId);
  });

  it("periodically retries cleanup of failed attempt objects left by a hard crash", async () => {
    const objectStorage = storage();
    const worker = new PgImageSuggestionWorker("postgresql://unused", "manual", objectStorage);
    const attemptId = "00000000-0000-4000-8000-000000000088";
    const objectKey = `ai-content/image-suggestions/${intentId}/attempts/${attemptId}/candidate.png`;
    let pending = true;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SET\n          "cleanupStatus"')) pending = false;
      return { rows: sql.includes('a."state"=\'FAILED_FINAL\'') && pending ? [{ attemptId, objectKey, uploadStarted: true, uploadSettled: true }] : [] };
    });
    Object.assign(worker as unknown as { pool: unknown }, { pool: { query, end: vi.fn() } });
    await expect(worker.recover()).resolves.toBe(0);
    await expect(worker.recover()).resolves.toBe(0);
    expect(objectStorage.delete).toHaveBeenCalledTimes(1);
    expect(objectStorage.delete).toHaveBeenCalledWith(objectKey);
  });

  it("keeps a failed orphan cleanup durable and retries it later", async () => {
    const objectStorage = storage();
    objectStorage.delete.mockRejectedValueOnce(new Error("temporary delete failure"));
    const worker = new PgImageSuggestionWorker("postgresql://unused", "manual", objectStorage);
    const attemptId = "00000000-0000-4000-8000-000000000077";
    const objectKey = `ai-content/image-suggestions/${intentId}/attempts/${attemptId}/candidate.png`;
    let completed = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SET\n          "cleanupStatus"')) completed = true;
      return { rows: sql.includes('a."state"=\'FAILED_FINAL\'') && !completed ? [{ attemptId, objectKey, uploadStarted: true, uploadSettled: true }] : [] };
    });
    Object.assign(worker as unknown as { pool: unknown }, { pool: { query, end: vi.fn() } });
    await worker.recover();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('"cleanupAttemptCount"="cleanupAttemptCount"+1'))).toBe(true);
    await worker.recover();
    expect(objectStorage.delete).toHaveBeenCalledTimes(2);
    expect(completed).toBe(true);
  });

  it("does not complete cleanup while a crashed upload outcome is unknown", async () => {
    const objectStorage = storage();
    const worker = new PgImageSuggestionWorker("postgresql://unused", "manual", objectStorage);
    const attemptId = "00000000-0000-4000-8000-000000000066";
    const objectKey = `ai-content/image-suggestions/${intentId}/attempts/${attemptId}/candidate.png`;
    let settled = false;
    let completed = false;
    objectStorage.delete.mockImplementation(async () => { settled = true; });
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SET\n          "cleanupStatus"')) completed = values?.[1] === true;
      return { rows: sql.includes('a."state"=\'FAILED_FINAL\'') && !completed ? [{ attemptId, objectKey, uploadStarted: true, uploadSettled: settled }] : [] };
    });
    Object.assign(worker as unknown as { pool: unknown }, { pool: { query, end: vi.fn() } });
    await worker.recover();
    expect(completed).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("IMAGE_UPLOAD_OUTCOME_UNKNOWN"))).toBe(true);
    await worker.recover();
    expect(completed).toBe(true);
    expect(objectStorage.delete).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate an active leased generation", async () => {
    const claim: FakeClient = { query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT i."id",i."state"')) return { rows: [{ id: intentId, state: "PROCESSING", latestAttemptState: "PROCESSING", latestLeaseActive: true, attemptCount: 1 }] };
      return { rows: [] };
    }), release: vi.fn() };
    const { worker, objectStorage } = configured([claim]);
    await worker.process(intentId);
    expect(objectStorage.uploadBytes).not.toHaveBeenCalled();
  });

  it("uploads and commits one no-likeness zero-cost candidate after claim and finalize gates", async () => {
    const claim: FakeClient = { query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT i."id",i."state"')) return { rows: [{ id: intentId, state: "QUEUED", contextPolicyFingerprint: "a".repeat(64), latestAttemptId: null, latestAttemptNumber: null, latestAttemptState: null, latestLeaseActive: false, attemptCount: 0 }] };
      if (sql.includes('FROM "ImageSuggestionIntent" i') && sql.includes("FOR SHARE OF")) return { rows: [{ id: intentId }] };
      return { rows: [] };
    }), release: vi.fn() };
    const finalize: FakeClient = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT i."state",a."leaseToken"')) {
        const insert = claim.query.mock.calls.find(([text]) => String(text).includes('INSERT INTO "ImageSuggestionAttempt"'));
        return { rows: [{ state: "PROCESSING", leaseToken: insert?.[1]?.[3], leaseActive: true, deadlineActive: true }] };
      }
      if (sql.includes('FROM "ImageSuggestionIntent" i') && sql.includes("FOR SHARE OF")) {
        expect(values).toEqual([intentId, "manual"]); return { rows: [{ id: intentId }] };
      }
      return { rows: [] };
    }), release: vi.fn() };
    const { worker, objectStorage } = configured([claim, finalize]);
    await worker.process(intentId);
    expect(objectStorage.uploadBytes).toHaveBeenCalledOnce();
    expect(objectStorage.uploadBytes.mock.calls[0]?.[0]?.objectKey).toMatch(
      new RegExp(`^ai-content/image-suggestions/${intentId}/attempts/[0-9a-f-]+/candidate\\.png$`),
    );
    const sql = finalize.query.mock.calls.map(([text]) => String(text));
    expect(sql.some((text) => text.includes('INSERT INTO "ImageSuggestionCandidate"'))).toBe(true);
    expect(sql.some((text) => text.includes("'NONE'"))).toBe(true);
  });

  it("a late expired attempt deletes only its own object after a replacement is accepted", async () => {
    const objects = new Set<string>();
    let releaseFirstUpload: (() => void) | undefined;
    let firstUploadStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { firstUploadStarted = resolve; });
    const releaseFirst = new Promise<void>((resolve) => { releaseFirstUpload = resolve; });
    let uploadNumber = 0;
    const sharedStorage = {
      uploadBytes: vi.fn(async ({ objectKey }: { objectKey: string; bytes: Buffer; contentType: string; sha256: string }) => {
        objects.add(objectKey);
        uploadNumber += 1;
        if (uploadNumber === 1) {
          firstUploadStarted?.();
          await releaseFirst;
        }
        return { etag: `etag-${uploadNumber}` };
      }),
      delete: vi.fn(async (objectKey: string) => { objects.delete(objectKey); }),
    };
    const claimClient = (replacement: boolean): FakeClient => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT i."id",i."state"')) return { rows: [{
          id: intentId,
          state: replacement ? "PROCESSING" : "QUEUED",
          contextPolicyFingerprint: "a".repeat(64),
          latestAttemptId: replacement ? "00000000-0000-4000-8000-000000000099" : null,
          latestAttemptNumber: replacement ? 1 : null,
          latestAttemptState: replacement ? "PROCESSING" : null,
          latestLeaseActive: false,
          attemptCount: replacement ? 1 : 0,
        }] };
        if (sql.includes('FROM "ImageSuggestionIntent" i') && sql.includes("FOR SHARE OF")) return { rows: [{ id: intentId }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const firstClaim = claimClient(false);
    const firstFinalize: FakeClient = {
      query: vi.fn(async (sql: string) => sql.includes('SELECT i."state",a."leaseToken"')
        ? { rows: [{ state: "PROCESSING", leaseToken: "replaced", leaseActive: false, deadlineActive: true }] }
        : { rows: [] }),
      release: vi.fn(),
    };
    const replacementClaim = claimClient(true);
    const replacementFinalize: FakeClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT i."state",a."leaseToken"')) {
          const insert = replacementClaim.query.mock.calls.find(([text]) => String(text).includes('INSERT INTO "ImageSuggestionAttempt"'));
          return { rows: [{ state: "PROCESSING", leaseToken: insert?.[1]?.[3], leaseActive: true, deadlineActive: true }] };
        }
        if (sql.includes('FROM "ImageSuggestionIntent" i') && sql.includes("FOR SHARE OF")) return { rows: [{ id: intentId }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const first = configured([firstClaim, firstFinalize], sharedStorage);
    const replacement = configured([replacementClaim, replacementFinalize], sharedStorage);
    const late = first.worker.process(intentId);
    await firstStarted;
    await replacement.worker.process(intentId);
    releaseFirstUpload?.();
    await late;
    const uploadedKeys = sharedStorage.uploadBytes.mock.calls.map(([input]) => input.objectKey);
    expect(new Set(uploadedKeys).size).toBe(2);
    expect(sharedStorage.delete).toHaveBeenCalledWith(uploadedKeys[0]);
    expect(objects).toEqual(new Set([uploadedKeys[1]]));
  });

  it("a late failed attempt cannot fail its replacement or persist storage details", async () => {
    const claim = claimClientForFailure();
    const fail: FakeClient = {
      query: vi.fn(async (sql: string) => ({ rowCount: sql.includes('UPDATE "ImageSuggestionAttempt"') ? 0 : null, rows: [] })),
      release: vi.fn(),
    };
    const objectStorage = storage();
    objectStorage.uploadBytes.mockRejectedValueOnce(new Error("private key at http://minio:9000"));
    const { worker } = configured([claim, fail], objectStorage);
    await expect(worker.process(intentId)).rejects.toThrow("private key");
    const attemptUpdate = fail.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE "ImageSuggestionAttempt"'));
    expect(attemptUpdate?.[1]?.[2]).toBe("IMAGE_STORAGE_UPLOAD_FAILED");
    expect(fail.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "ImageSuggestionIntent"'))).toBe(false);
  });
});

function claimClientForFailure(): FakeClient {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT i."id",i."state"')) return { rows: [{ id: intentId, state: "QUEUED", contextPolicyFingerprint: "a".repeat(64), latestAttemptId: null, latestAttemptNumber: null, latestAttemptState: null, latestLeaseActive: false, attemptCount: 0 }] };
      if (sql.includes('FROM "ImageSuggestionIntent" i') && sql.includes("FOR SHARE OF")) return { rows: [{ id: intentId }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}
