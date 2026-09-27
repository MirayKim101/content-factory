import { describe, expect, it, vi } from "vitest";

import { MontageReconciliationStartup } from "../src/editorial-content/infrastructure/montage-reconciliation.startup.js";

describe("MontageReconciliationStartup", () => {
  it("drains an active reconciliation before module shutdown completes", async () => {
    let finish!: () => void;
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const startup = new MontageReconciliationStartup({
      execute,
    } as never);

    startup.onApplicationBootstrap();
    const shutdown = startup.onModuleDestroy();
    let drained = false;
    void shutdown.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finish();
    await shutdown;
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
