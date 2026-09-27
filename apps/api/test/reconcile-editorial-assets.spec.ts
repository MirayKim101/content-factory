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

  it("aborts and drains startup reconciliation during module shutdown", async () => {
    let signal: AbortSignal | undefined;
    const reconcile = {
      execute: vi.fn((nextSignal?: AbortSignal) => {
        signal = nextSignal;
        return new Promise<void>((_resolve, reject) => {
          nextSignal?.addEventListener(
            "abort",
            () => reject(nextSignal.reason),
            { once: true },
          );
        });
      }),
    };
    const startup = new EditorialAssetReconciliationStartup(
      reconcile as unknown as ReconcileEditorialAssets,
    );

    const bootstrap = startup.onApplicationBootstrap();
    await Promise.resolve();
    await startup.onModuleDestroy();
    await bootstrap;

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toEqual(
      new Error("EDITORIAL_RECONCILIATION_SHUTDOWN"),
    );
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
    expect(storage.deleteObject).toHaveBeenCalledWith(
      "private/failed",
      undefined,
    );
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

  it("propagates cancellation through storage without persisting a false failure", async () => {
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
      failAsset: vi.fn(),
    } as unknown as EditorialRepository;
    const storage = {
      headObject: vi.fn(
        (_key: string, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    } as unknown as EditorialStorage;
    const controller = new AbortController();
    const execution = new ReconcileEditorialAssets(repository, storage).execute(
      controller.signal,
    );

    controller.abort(new Error("EDITORIAL_RECONCILIATION_SHUTDOWN"));

    await expect(execution).rejects.toThrow(
      "EDITORIAL_RECONCILIATION_SHUTDOWN",
    );
    expect(repository.failAsset).not.toHaveBeenCalled();
  });
});
