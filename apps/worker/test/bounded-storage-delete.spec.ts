import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteStorageObjectBestEffort } from "../src/application/bounded-storage-delete.js";

afterEach(() => vi.useRealTimers());

describe("deleteStorageObjectBestEffort", () => {
  it("bounds an unavailable object-store cleanup", async () => {
    vi.useFakeTimers();
    const remove = vi.fn(
      async (_objectKey: string, signal?: AbortSignal): Promise<void> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const cleanup = deleteStorageObjectBestEffort(
      { delete: remove },
      "owned/orphan.mp4",
      25,
    );
    await vi.advanceTimersByTimeAsync(25);

    await expect(cleanup).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith(
      "owned/orphan.mp4",
      expect.any(AbortSignal),
    );
  });
});
