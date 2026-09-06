import { describe, expect, it, vi } from "vitest";

import type { CreatorContextRepository } from "../src/ai-content/application/creator-context-repository.port.js";
import type { CreatorContextStorage } from "../src/ai-content/application/creator-context-storage.port.js";
import { ReconcileCreatorReferences } from "../src/ai-content/application/reconcile-creator-references.js";

const staleBefore = new Date("2026-09-06T00:00:00.000Z");

describe("creator reference reconciliation", () => {
  it("finalizes a pending row only when the durable object matches", async () => {
    const repository = repositoryWith([
      recoverable({ id: "asset-ready", status: "PENDING" }),
    ]);
    const storage = storageWith({
      sizeBytes: 4,
      sha256: "a".repeat(64),
      etag: "etag-1",
      version: "version-1",
    });

    await new ReconcileCreatorReferences(repository, storage).execute({
      staleBefore,
      limit: 10,
    });

    expect(repository.finalizeReference).toHaveBeenCalledWith("asset-ready", {
      etag: "etag-1",
      version: "version-1",
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("fails and cleans a pending row when its durable object is absent", async () => {
    const repository = repositoryWith([
      recoverable({ id: "asset-missing", status: "PENDING" }),
    ]);
    const storage = storageWith(null);

    await new ReconcileCreatorReferences(repository, storage).execute({
      staleBefore,
      limit: 10,
    });

    expect(repository.failReference).toHaveBeenCalledWith(
      "asset-missing",
      "CREATOR_REFERENCE_RECOVERY_FAILED",
    );
    expect(storage.deleteObject).toHaveBeenCalledWith("object/asset-missing");
    expect(repository.completeReferenceCleanup).toHaveBeenCalledWith(
      "asset-missing",
    );
  });

  it("retries cleanup for a terminal failed row", async () => {
    const repository = repositoryWith([
      recoverable({ id: "asset-failed", status: "FAILED_FINAL" }),
    ]);
    const storage = storageWith(null);

    await new ReconcileCreatorReferences(repository, storage).execute({
      staleBefore,
      limit: 10,
    });

    expect(storage.headObject).not.toHaveBeenCalled();
    expect(storage.deleteObject).toHaveBeenCalledWith("object/asset-failed");
    expect(repository.completeReferenceCleanup).toHaveBeenCalledWith(
      "asset-failed",
    );
  });

  it("persists a bounded cleanup retry marker when deletion fails", async () => {
    const repository = repositoryWith([
      recoverable({ id: "asset-retry", status: "FAILED_FINAL" }),
    ]);
    const storage = storageWith(null);
    vi.mocked(storage.deleteObject).mockRejectedValueOnce(new Error("private"));

    await new ReconcileCreatorReferences(repository, storage).execute({
      staleBefore,
      limit: 10,
    });

    expect(repository.recordReferenceCleanupFailure).toHaveBeenCalledWith(
      "asset-retry",
      "OBJECT_DELETE_FAILED",
    );
  });
});

function recoverable(input: {
  id: string;
  status: "PENDING" | "FAILED_FINAL";
}) {
  return {
    ...input,
    cleanupStatus: input.status === "PENDING" ? "NOT_REQUIRED" : "PENDING",
    objectKey: `object/${input.id}`,
    sizeBytes: 4n,
    sha256: "a".repeat(64),
  } as const;
}

function repositoryWith(
  rows: Awaited<
    ReturnType<CreatorContextRepository["listRecoverableReferences"]>
  >,
): CreatorContextRepository {
  return {
    listRecoverableReferences: vi.fn().mockResolvedValue(rows),
    finalizeReference: vi.fn().mockResolvedValue(undefined),
    failReference: vi.fn().mockResolvedValue(undefined),
    completeReferenceCleanup: vi.fn().mockResolvedValue(undefined),
    recordReferenceCleanupFailure: vi.fn().mockResolvedValue(undefined),
  } as unknown as CreatorContextRepository;
}

function storageWith(
  head: Awaited<ReturnType<CreatorContextStorage["headObject"]>>,
): CreatorContextStorage {
  return {
    headObject: vi.fn().mockResolvedValue(head),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  } as unknown as CreatorContextStorage;
}
