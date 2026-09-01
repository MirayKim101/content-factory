import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReconcilePendingUploads } from "../src/projects/application/reconcile-pending-uploads.js";
import { PendingUploadReconciliationStartup } from "../src/projects/infrastructure/pending-upload-reconciliation.startup.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.SOURCE_PENDING_STARTUP_TIMEOUT_MS;
  delete process.env.S3_ACCESS_KEY;
  delete process.env.S3_SECRET_KEY;
});

describe("PendingUploadReconciliationStartup", () => {
  it("does not block boot and reports its bounded timeout", async () => {
    vi.useFakeTimers();
    process.env.SOURCE_PENDING_STARTUP_TIMEOUT_MS = "1";
    process.env.S3_ACCESS_KEY = "test-access";
    process.env.S3_SECRET_KEY = "test-secret";
    const execute = vi.fn(
      (_before: Date, _limit: number, signal: AbortSignal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const logger = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const startup = new PendingUploadReconciliationStartup({
      execute,
    } as unknown as ReconcilePendingUploads);

    expect(startup.onApplicationBootstrap()).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(logger).toHaveBeenCalledWith(
      "SOURCE_PENDING_RECONCILIATION_TIMEOUT",
    );
  });
});
