import { describe, expect, it, vi } from "vitest";

import { SingleFlightTask } from "../src/common/single-flight-task.js";

describe("SingleFlightTask", () => {
  it("deduplicates ticks and exposes the active execution to shutdown", async () => {
    let finish!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const singleFlight = new SingleFlightTask(task);

    const first = singleFlight.run();
    expect(singleFlight.run()).toBe(first);
    let drained = false;
    void singleFlight.wait().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finish();
    await singleFlight.wait();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs again after the active execution settles", async () => {
    const task = vi.fn(async () => undefined);
    const singleFlight = new SingleFlightTask(task);

    await singleFlight.run();
    await singleFlight.run();

    expect(task).toHaveBeenCalledTimes(2);
  });
});
