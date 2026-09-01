import { describe, expect, it, vi } from "vitest";

import type { ObjectStorage } from "../src/projects/application/object-storage.port.js";
import type { ProjectRepository } from "../src/projects/application/project-repository.port.js";
import { ReconcilePendingUploads } from "../src/projects/application/reconcile-pending-uploads.js";

const pending = {
  projectId: "project",
  sourceId: "source",
  artifactId: "artifact",
  objectKey: "private-key",
  expectedSizeBytes: 100n,
  expectedSha256: "a".repeat(64),
  createdAt: new Date(0),
};

function projects(): ProjectRepository {
  return {
    createPendingUpload: vi.fn(),
    finalizeReady: vi.fn(),
    markFailed: vi.fn(),
    requestCleanup: vi.fn(),
    findByIdempotencyKey: vi.fn(),
    getById: vi.fn(),
    findStalePending: vi.fn(async () => [pending]),
    findPendingCleanup: vi.fn(async () => []),
    markCleanupCompleted: vi.fn(),
    recordCleanupFailure: vi.fn(),
  };
}

function objects(
  result: { etag: string; sizeBytes: number; sha256: string } | null,
): ObjectStorage {
  return {
    ensurePrivateBucket: vi.fn(),
    putFile: vi.fn(),
    headObject: vi.fn(async () => result),
    deleteObject: vi.fn(),
  };
}

describe("ReconcilePendingUploads", () => {
  it("finalizes a stale row when its object exists", async () => {
    const repository = projects();
    const reconciler = new ReconcilePendingUploads(
      repository,
      objects({ etag: "etag", sizeBytes: 100, sha256: "a".repeat(64) }),
    );

    await expect(
      reconciler.execute(new Date(), 25, new AbortController().signal),
    ).resolves.toBe(1);
    expect(repository.finalizeReady).toHaveBeenCalledWith("artifact", {
      etag: "etag",
      sizeBytes: 100,
      sha256: "a".repeat(64),
    });
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("moves a stale row to FAILED_FINAL when its object is absent", async () => {
    const repository = projects();
    const reconciler = new ReconcilePendingUploads(repository, objects(null));

    await reconciler.execute(new Date(), 25, new AbortController().signal);

    expect(repository.markFailed).toHaveBeenCalledWith(
      "project",
      "SOURCE_OBJECT_MISSING_AFTER_RESTART",
      "Source object was not found during recovery.",
      false,
    );
  });

  it("fails and schedules cleanup when recovered object integrity mismatches", async () => {
    const repository = projects();
    const reconciler = new ReconcilePendingUploads(
      repository,
      objects({ etag: "etag", sizeBytes: 99, sha256: "b".repeat(64) }),
    );

    await reconciler.execute(new Date(), 25, new AbortController().signal);

    expect(repository.finalizeReady).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(
      "project",
      "SOURCE_OBJECT_INTEGRITY_MISMATCH",
      "Source object failed integrity verification during recovery.",
      true,
    );
  });

  it("does not mutate after its deadline aborts", async () => {
    const repository = projects();
    const controller = new AbortController();
    const objectStorage = objects({
      etag: "etag",
      sizeBytes: 100,
      sha256: "a".repeat(64),
    });
    objectStorage.headObject = vi.fn(async () => {
      controller.abort(new Error("SOURCE_PENDING_RECONCILIATION_TIMEOUT"));
      return { etag: "etag", sizeBytes: 100, sha256: "a".repeat(64) };
    });

    await expect(
      new ReconcilePendingUploads(repository, objectStorage).execute(
        new Date(),
        25,
        controller.signal,
      ),
    ).rejects.toThrow("SOURCE_PENDING_RECONCILIATION_TIMEOUT");
    expect(repository.finalizeReady).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("lets an in-flight DB transition finish but starts no next item after abort", async () => {
    const repository = projects();
    repository.findStalePending = vi.fn(async () => [
      pending,
      { ...pending, projectId: "project-2", artifactId: "artifact-2" },
    ]);
    let releaseFinalize: (() => void) | undefined;
    let transitionCompleted = false;
    repository.finalizeReady = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFinalize = () => {
            transitionCompleted = true;
            resolve();
          };
        }),
    );
    const objectStorage = objects({
      etag: "etag",
      sizeBytes: 100,
      sha256: "a".repeat(64),
    });
    const controller = new AbortController();
    const execution = new ReconcilePendingUploads(
      repository,
      objectStorage,
    ).execute(new Date(), 25, controller.signal);
    await vi.waitFor(() =>
      expect(repository.finalizeReady).toHaveBeenCalledOnce(),
    );

    controller.abort(new Error("SOURCE_PENDING_RECONCILIATION_TIMEOUT"));
    releaseFinalize?.();

    await expect(execution).rejects.toThrow(
      "SOURCE_PENDING_RECONCILIATION_TIMEOUT",
    );
    expect(transitionCompleted).toBe(true);
    expect(objectStorage.headObject).toHaveBeenCalledOnce();
    expect(repository.finalizeReady).toHaveBeenCalledOnce();
  });

  it("persists a retryable cleanup failure instead of swallowing deletion", async () => {
    const repository = projects();
    repository.findStalePending = vi.fn(async () => []);
    repository.findPendingCleanup = vi.fn(async () => [
      {
        projectId: "project",
        artifactId: "artifact",
        objectKey: "private-key",
      },
    ]);
    const objectStorage = objects(null);
    objectStorage.deleteObject = vi.fn(async () =>
      Promise.reject(new Error("storage")),
    );

    await new ReconcilePendingUploads(repository, objectStorage).execute(
      new Date(),
      25,
      new AbortController().signal,
    );

    expect(repository.recordCleanupFailure).toHaveBeenCalledWith(
      "artifact",
      "OBJECT_DELETE_FAILED",
    );
    expect(repository.markCleanupCompleted).not.toHaveBeenCalled();
  });
});
