import { describe, expect, it, vi } from "vitest";

import { SingleFlightTask } from "../src/application/single-flight-task.js";

describe("SingleFlightTask", () => {
  it("shares one execution and lets shutdown wait for it", async () => {
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
    let settled = false;
    void singleFlight.wait().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await singleFlight.wait();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("allows a new execution after the previous one settles", async () => {
    const task = vi.fn(async () => undefined);
    const singleFlight = new SingleFlightTask(task);

    await singleFlight.run();
    await singleFlight.run();

    expect(task).toHaveBeenCalledTimes(2);
  });
});
