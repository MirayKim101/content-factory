import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CutJobRepository,
  MediaRuntime,
  WorkerObjectStorage,
} from "../src/ports.js";
import { ManualCutWorker } from "../src/worker.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("ManualCutWorker", () => {
  it("fails impossible scratch admission without consuming an attempt", async () => {
    const repository = fakeRepository();
    repository.getAdmission = vi.fn(async () => ({
      sourceSizeBytes: 100n,
      requestedDurationMs: 1_000,
    }));
    repository.failWithoutAttempt = vi.fn(async () => true);
    const runtime = fakeRuntime();
    const worker = new ManualCutWorker(
      repository,
      fakeStorage(),
      runtime,
      { inspect: async () => ({ outcome: "IMPOSSIBLE" }) },
      { now: () => NOW },
      config(await scratch()),
    );

    await expect(worker.execute(JOB_ID)).resolves.toBe("DONE");
    expect(repository.failWithoutAttempt).toHaveBeenCalledWith(
      JOB_ID,
      "SCRATCH_CAPACITY_EXCEEDED",
      expect.any(String),
    );
    expect(repository.claim).not.toHaveBeenCalled();
    expect(runtime.probe).not.toHaveBeenCalled();
  });

  it("stores monotonic measured phases and output intent before upload", async () => {
    const calls: string[] = [];
    const progress: Array<{ stage: string; current: bigint }> = [];
    const repository = fakeRepository();
    repository.getAdmission = vi.fn(async () => ({
      sourceSizeBytes: 100n,
      requestedDurationMs: 1_000,
    }));
    repository.claim = vi.fn(async () => ({
      outcome: "CLAIMED" as const,
      claim: claimedCut(),
    }));
    repository.recordProgress = vi.fn(async (_lease, stage, current) => {
      progress.push({ stage, current });
      return true;
    });
    repository.persistOutputIntent = vi.fn(async () => {
      calls.push("intent");
      return true;
    });
    repository.complete = vi.fn(async () => {
      calls.push("complete");
      return true;
    });
    const storage = fakeStorage();
    storage.downloadToFile = vi.fn(async (input) => {
      await writeFile(input.filePath, "source");
      input.onProgress({ current: 100n, total: 100n });
    });
    storage.putFile = vi.fn(async (input) => {
      calls.push("upload");
      input.onProgress({ current: 6n, total: 6n });
      return { etag: "etag" };
    });
    let probes = 0;
    const runtime = fakeRuntime();
    runtime.probe = vi.fn(async () => ({
      durationMs: probes++ === 0 ? 6_000 : 1_000,
      streams: [{ type: "video" }],
    }));
    runtime.cut = vi.fn(async (input) => {
      input.onProgress(900);
      input.onProgress(400);
      input.onProgress(1_000);
      await writeFile(input.outputPath, "output");
    });
    const worker = new ManualCutWorker(
      repository,
      storage,
      runtime,
      {
        inspect: async () => ({
          outcome: "AVAILABLE",
          usableBytes: 1_000_000n,
        }),
      },
      { now: () => NOW },
      config(await scratch()),
      {
        emit: () => {
          throw new Error("telemetry unavailable");
        },
      },
    );

    await expect(worker.execute(JOB_ID)).resolves.toBe("DONE");
    expect(progress).toEqual([
      { stage: "SOURCE_DOWNLOAD", current: 100n },
      { stage: "ENCODING", current: 900n },
      { stage: "ENCODING", current: 900n },
      { stage: "ENCODING", current: 1_000n },
      { stage: "OUTPUT_UPLOAD", current: 6n },
    ]);
    expect(calls).toEqual(["intent", "upload", "complete"]);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("rejects corrupted staged source bytes before invoking the media runtime", async () => {
    const repository = fakeRepository();
    repository.getAdmission = vi.fn(async () => ({
      sourceSizeBytes: 100n,
      requestedDurationMs: 1_000,
    }));
    repository.claim = vi.fn(async () => ({
      outcome: "CLAIMED" as const,
      claim: claimedCut(),
    }));
    const storage = fakeStorage();
    storage.downloadToFile = vi.fn(async (input) => {
      await writeFile(input.filePath, "corrupted");
    });
    const runtime = fakeRuntime();
    const worker = new ManualCutWorker(
      repository,
      storage,
      runtime,
      {
        inspect: async () => ({
          outcome: "AVAILABLE",
          usableBytes: 1_000_000n,
        }),
      },
      { now: () => NOW },
      config(await scratch()),
    );

    await worker.execute(JOB_ID);
    expect(runtime.probe).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        retryable: false,
        code: "INVALID_SOURCE_MEDIA",
      }),
    );
  });

  it("classifies object storage failures separately from media failures", async () => {
    const repository = fakeRepository();
    repository.getAdmission = vi.fn(async () => ({
      sourceSizeBytes: 100n,
      requestedDurationMs: 1_000,
    }));
    repository.claim = vi.fn(async () => ({
      outcome: "CLAIMED" as const,
      claim: claimedCut(),
    }));
    const storage = fakeStorage();
    storage.downloadToFile = vi.fn(async () => {
      throw new Error("vendor detail must not escape");
    });
    const worker = new ManualCutWorker(
      repository,
      storage,
      fakeRuntime(),
      {
        inspect: async () => ({
          outcome: "AVAILABLE",
          usableBytes: 1_000_000n,
        }),
      },
      { now: () => NOW },
      config(await scratch()),
    );

    await expect(worker.execute(JOB_ID)).resolves.toBe("DONE");
    expect(repository.fail).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        retryable: true,
        code: "STORAGE_OPERATION_FAILED",
        message: "Object storage was temporarily unavailable.",
      }),
    );
  });

  it("aborts a blocked upload after lease loss and cleans only its attempt key", async () => {
    const repository = fakeRepository();
    repository.getAdmission = vi.fn(async () => ({
      sourceSizeBytes: 100n,
      requestedDurationMs: 1_000,
    }));
    repository.claim = vi.fn(async () => ({
      outcome: "CLAIMED" as const,
      claim: claimedCut(),
    }));
    let uploadStarted!: () => void;
    const blockedUpload = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    repository.heartbeat = vi.fn(async () => {
      await blockedUpload;
      return false;
    });
    const storage = fakeStorage();
    storage.downloadToFile = vi.fn(async (input) => {
      await writeFile(input.filePath, "source");
    });
    let uploadAborted = false;
    storage.putFile = vi.fn(
      async (input) =>
        new Promise<never>((_resolve, reject) => {
          uploadStarted();
          input.signal.addEventListener(
            "abort",
            () => {
              uploadAborted = true;
              reject(input.signal.reason);
            },
            { once: true },
          );
        }),
    );
    storage.headObject = vi.fn(async () => true);
    const runtime = fakeRuntime();
    let probes = 0;
    runtime.probe = vi.fn(async () => ({
      durationMs: probes++ === 0 ? 6_000 : 1_000,
      streams: [{ type: "video" }],
    }));
    runtime.cut = vi.fn(async (input) => {
      await writeFile(input.outputPath, "output");
    });
    const workerConfig = config(await scratch());
    workerConfig.heartbeatMs = 1;
    const worker = new ManualCutWorker(
      repository,
      storage,
      runtime,
      {
        inspect: async () => ({
          outcome: "AVAILABLE",
          usableBytes: 1_000_000n,
        }),
      },
      { now: () => NOW },
      workerConfig,
    );

    await expect(worker.execute(JOB_ID)).resolves.toBe("DONE");
    const key =
      "projects/44444444-4444-4444-8444-444444444444/cuts/11111111-1111-4111-8111-111111111111/attempts/1-22222222-2222-4222-8222-222222222222.mp4";
    expect(uploadAborted).toBe(true);
    expect(repository.complete).not.toHaveBeenCalled();
    expect(storage.headObject).toHaveBeenCalledWith(
      key,
      expect.any(AbortSignal),
    );
    expect(storage.deleteObject).toHaveBeenCalledWith(
      key,
      expect.any(AbortSignal),
    );
    expect(repository.completeOutputCleanup).toHaveBeenCalledWith(
      ATTEMPT_ID,
      NOW,
    );
  });

  it("removes only DB-confirmed terminal scratch directories", async () => {
    const root = await scratch();
    const terminal = "66666666-6666-4666-8666-666666666666";
    const newlyActive = "77777777-7777-4777-8777-777777777777";
    await mkdir(join(root, terminal));
    await mkdir(join(root, newlyActive));
    const repository = fakeRepository();
    repository.findScratchCleanupAttemptIds = vi.fn(async (candidates) => {
      expect(candidates).toEqual(
        expect.arrayContaining([terminal, newlyActive]),
      );
      return [terminal];
    });
    const worker = new ManualCutWorker(
      repository,
      fakeStorage(),
      fakeRuntime(),
      {
        inspect: async () => ({
          outcome: "AVAILABLE",
          usableBytes: 1_000_000n,
        }),
      },
      { now: () => NOW },
      config(root),
    );

    await worker.reconcile();
    await expect(stat(join(root, terminal))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(root, newlyActive))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it("checks every bounded scratch batch and reaches entries beyond 100", async () => {
    const root = await scratch();
    const ids = Array.from(
      { length: 101 },
      (_, index) =>
        `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    await Promise.all(ids.map((id) => mkdir(join(root, id))));
    const terminal = ids[100]!;
    const repository = fakeRepository();
    repository.findScratchCleanupAttemptIds = vi.fn(async (candidates) =>
      candidates.includes(terminal) ? [terminal] : [],
    );
    const worker = new ManualCutWorker(
      repository,
      fakeStorage(),
      fakeRuntime(),
      {
        inspect: async () => ({
          outcome: "AVAILABLE",
          usableBytes: 1_000_000n,
        }),
      },
      { now: () => NOW },
      config(root),
    );

    await worker.reconcile();
    expect(repository.findScratchCleanupAttemptIds).toHaveBeenCalledTimes(2);
    await expect(stat(join(root, terminal))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("bounds stalled cleanup and leaves a safe retry record", async () => {
    const repository = fakeRepository();
    repository.findPendingOutputCleanup = vi.fn(async () => [
      {
        attemptId: ATTEMPT_ID,
        jobId: JOB_ID,
        attemptNumber: 1,
        objectKey: "cuts/pending.mp4",
      },
    ]);
    const storage = fakeStorage();
    storage.headObject = vi.fn(
      async (_key, signal) =>
        new Promise<boolean>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const workerConfig = config(await scratch());
    workerConfig.cleanupTimeoutMs = 1;
    const worker = new ManualCutWorker(
      repository,
      storage,
      fakeRuntime(),
      {
        inspect: async () => ({
          outcome: "AVAILABLE",
          usableBytes: 1_000_000n,
        }),
      },
      { now: () => NOW },
      workerConfig,
    );

    await expect(worker.reconcile()).resolves.toBe(1);
    expect(repository.failOutputCleanup).toHaveBeenCalledWith(
      ATTEMPT_ID,
      "STORAGE_CLEANUP_FAILED",
    );
    expect(repository.completeOutputCleanup).not.toHaveBeenCalled();
  });

  it("completes pending output cleanup for the exact recorded key", async () => {
    const repository = fakeRepository();
    repository.findPendingOutputCleanup = vi.fn(async () => [
      {
        attemptId: ATTEMPT_ID,
        jobId: JOB_ID,
        attemptNumber: 1,
        objectKey: "projects/project/cuts/job/attempt.mp4",
      },
    ]);
    const storage = fakeStorage();
    storage.headObject = vi.fn(async () => true);
    const worker = new ManualCutWorker(
      repository,
      storage,
      fakeRuntime(),
      {
        inspect: async () => ({
          outcome: "AVAILABLE",
          usableBytes: 1_000_000n,
        }),
      },
      { now: () => NOW },
      config(await scratch()),
    );

    await expect(worker.reconcile()).resolves.toBe(1);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      "projects/project/cuts/job/attempt.mp4",
      expect.any(AbortSignal),
    );
    expect(repository.completeOutputCleanup).toHaveBeenCalledWith(
      ATTEMPT_ID,
      NOW,
    );
  });
});

const NOW = new Date("2026-09-09T00:00:00.000Z");
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";

function claimedCut() {
  return {
    job: {
      id: JOB_ID,
      projectId: "44444444-4444-4444-8444-444444444444",
      sourceId: "55555555-5555-4555-8555-555555555555",
      sourceVersion: 1,
      sourceSha256:
        "41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d",
      startMs: 1_000,
      endMs: 2_000,
      recipeVersion: "horizontal-cut-v1" as const,
      state: "RUNNING" as const,
      stage: "CLAIMED",
      progress: null,
      attempts: 1,
      queueReason: null,
      admissionDeadlineAt: new Date(NOW.getTime() + 900_000),
      failure: null,
      revision: 1,
      artifact: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    leaseToken: TOKEN,
    claimRevision: 1,
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    source: {
      objectKey: "source/object.mp4",
      sizeBytes: 100n,
      contentType: "video/mp4",
    },
  };
}

function fakeRepository(): CutJobRepository {
  return {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    getAuthorizedSourceMedia: vi.fn(),
    getReadyDownload: vi.fn(),
    getAdmission: vi.fn(async () => null),
    claim: vi.fn(async () => ({ outcome: "NOT_RUNNABLE" as const })),
    heartbeat: vi.fn(async () => true),
    recordProgress: vi.fn(async () => true),
    persistOutputIntent: vi.fn(async () => true),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    markScratchWait: vi.fn(async () => "WAITING" as const),
    failWithoutAttempt: vi.fn(async () => true),
    reconcileExpired: vi.fn(async () => []),
    findRunnable: vi.fn(async () => []),
    findPendingOutputCleanup: vi.fn(async () => []),
    findScratchCleanupAttemptIds: vi.fn(async () => []),
    completeOutputCleanup: vi.fn(async () => undefined),
    failOutputCleanup: vi.fn(async () => undefined),
  };
}

function fakeStorage(): WorkerObjectStorage {
  return {
    downloadToFile: vi.fn(),
    putFile: vi.fn(),
    headObject: vi.fn(async () => false),
    deleteObject: vi.fn(async () => undefined),
  };
}

function fakeRuntime(): MediaRuntime {
  return { probe: vi.fn(), cut: vi.fn() };
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "content-factory-cut-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function config(scratchRoot: string) {
  return {
    scratchRoot,
    leaseMs: 120_000,
    heartbeatMs: 30_000,
    heavyConcurrency: 1,
    scratchSafetyBytes: 10n,
    outputBitsPerSecond: 8_000n,
    scratchCapacityBytes: 1_000_000n,
    cleanupTimeoutMs: 100,
  };
}
