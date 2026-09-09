import { describe, expect, it, vi } from "vitest";

import { observeConsumer, passStartupBarrier } from "../src/lifecycle.js";

describe("worker lifecycle", () => {
  it("does not reach the queue before successful initial reconciliation", async () => {
    const calls: string[] = [];
    await expect(
      passStartupBarrier({
        connectDatabase: async () => {
          calls.push("database");
        },
        reconcile: async () => {
          calls.push("reconcile");
          throw new Error("reconcile failed");
        },
        waitForConsumer: async () => {
          calls.push("consumer");
        },
      }),
    ).rejects.toThrow("reconcile failed");
    expect(calls).toEqual(["database", "reconcile"]);
  });

  it("waits for BullMQ readiness before the startup barrier opens", async () => {
    let releaseConsumer!: () => void;
    const consumerReady = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    let opened = false;
    const startup = passStartupBarrier({
      connectDatabase: async () => undefined,
      reconcile: async () => undefined,
      waitForConsumer: () => consumerReady,
    }).then(() => {
      opened = true;
    });
    await Promise.resolve();
    expect(opened).toBe(false);
    releaseConsumer();
    await startup;
    expect(opened).toBe(true);
  });

  it("routes an unexpected consumer stop into fatal cleanup", async () => {
    const fatal = vi.fn(async () => undefined);
    observeConsumer(Promise.reject(new Error("consumer stopped")), fatal);
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    expect(fatal).toHaveBeenCalledWith(expect.any(Error));
  });
});
