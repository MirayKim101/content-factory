import { describe, expect, it, vi } from "vitest";

import { ReconcileScheduledPublications } from "../src/application/reconcile-scheduled-publications.js";

describe("ReconcileScheduledPublications", () => {
  it("isolates one failed intent and continues processing the due batch", async () => {
    const source = {
      due: vi.fn().mockResolvedValue(["first", "broken", "last"]),
    };
    const processor = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error("PUBLICATION_ATTEMPT_FAILED"))
        .mockResolvedValueOnce(true),
    };
    const onFailure = vi.fn();

    await expect(
      new ReconcileScheduledPublications(
        source,
        processor,
        onFailure,
      ).execute(),
    ).resolves.toBe(2);

    expect(processor.execute).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledWith("broken", expect.any(Error));
  });

  it("does not count an intent that was already claimed elsewhere", async () => {
    const source = { due: vi.fn().mockResolvedValue(["claimed"]) };
    const processor = { execute: vi.fn().mockResolvedValue(false) };

    await expect(
      new ReconcileScheduledPublications(source, processor).execute(),
    ).resolves.toBe(0);
  });

  it("surfaces a failed due-query because no batch can be processed", async () => {
    const source = {
      due: vi.fn().mockRejectedValue(new Error("DATABASE_UNAVAILABLE")),
    };
    const processor = { execute: vi.fn() };

    await expect(
      new ReconcileScheduledPublications(source, processor).execute(),
    ).rejects.toThrow("DATABASE_UNAVAILABLE");
    expect(processor.execute).not.toHaveBeenCalled();
  });
});
