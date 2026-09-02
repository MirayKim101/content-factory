import { describe, expect, it, vi } from "vitest";

import { ReconcileEditorialAssets } from "../src/editorial-content/application/reconcile-editorial-assets.js";
import { EditorialAssetReconciliationStartup } from "../src/editorial-content/infrastructure/editorial-asset-reconciliation.startup.js";
import type { EditorialRepository } from "../src/editorial-content/application/editorial-repository.port.js";
import type { EditorialStorage } from "../src/editorial-content/application/editorial-storage.port.js";

describe("editorial asset restart reconciliation", () => {
  it("runs the durable reconciliation pass during application startup", async () => {
    const reconcile = { execute: vi.fn().mockResolvedValue(undefined) };
    await new EditorialAssetReconciliationStartup(
      reconcile as unknown as ReconcileEditorialAssets,
    ).onApplicationBootstrap();
    expect(reconcile.execute).toHaveBeenCalledOnce();
  });

  it("finalizes an exact stored object and retries durable cleanup", async () => {
    const repository = {
      listRecoverableAssets: vi.fn().mockResolvedValue([
        {
          id: "pending",
          status: "PENDING",
          cleanupStatus: "NOT_REQUIRED",
          objectKey: "private/pending",
          sizeBytes: 123n,
          sha256: "a".repeat(64),
        },
        {
          id: "failed",
          status: "FAILED_FINAL",
          cleanupStatus: "PENDING",
          objectKey: "private/failed",
          sizeBytes: 123n,
          sha256: "b".repeat(64),
        },
      ]),
      finalizeAsset: vi.fn(),
      completeAssetCleanup: vi.fn(),
      recordAssetCleanupFailure: vi.fn(),
    } as unknown as EditorialRepository;
    const storage = {
      headObject: vi.fn().mockResolvedValue({
        sizeBytes: 123,
        sha256: "a".repeat(64),
        etag: "etag",
      }),
      deleteObject: vi.fn(),
    } as unknown as EditorialStorage;

    await new ReconcileEditorialAssets(repository, storage).execute();

    expect(repository.finalizeAsset).toHaveBeenCalledWith("pending", {
      sizeBytes: 123,
      sha256: "a".repeat(64),
      etag: "etag",
    });
    expect(storage.deleteObject).toHaveBeenCalledWith("private/failed");
    expect(repository.completeAssetCleanup).toHaveBeenCalledWith("failed");
  });

  it("persists failure intent before deleting a missing or mismatched object", async () => {
    const order: string[] = [];
    const repository = {
      listRecoverableAssets: vi.fn().mockResolvedValue([
        {
          id: "pending",
          status: "PENDING",
          cleanupStatus: "NOT_REQUIRED",
          objectKey: "private/pending",
          sizeBytes: 123n,
          sha256: "a".repeat(64),
        },
      ]),
      failAsset: vi.fn().mockImplementation(async () => order.push("intent")),
      completeAssetCleanup: vi
        .fn()
        .mockImplementation(async () => order.push("complete")),
      recordAssetCleanupFailure: vi.fn(),
    } as unknown as EditorialRepository;
    const storage = {
      headObject: vi.fn().mockResolvedValue(null),
      deleteObject: vi
        .fn()
        .mockImplementation(async () => order.push("delete")),
    } as unknown as EditorialStorage;

    await new ReconcileEditorialAssets(repository, storage).execute();

    expect(order).toEqual(["intent", "delete", "complete"]);
  });
});
