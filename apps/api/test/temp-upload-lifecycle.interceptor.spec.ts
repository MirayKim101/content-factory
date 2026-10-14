import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { TempUploadLifecycleInterceptor } from "../src/projects/presentation/temp-upload-lifecycle.interceptor.js";
import { UploadStagingUnavailableException } from "../src/projects/presentation/upload-staging-admission.service.js";

describe("TempUploadLifecycleInterceptor", () => {
  it("releases admission when the transport aborts while reservation is pending", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "cf-upload-lifecycle-"));
    const request = Object.assign(new EventEmitter(), {
      aborted: false,
      destroyed: false,
    });
    const response = Object.assign(new EventEmitter(), { destroyed: false });
    const release = vi.fn();
    let resolveReservation:
      | ((value: { rootDirectory: string; release: () => void }) => void)
      | undefined;
    const reserve = vi.fn(
      () =>
        new Promise<{ rootDirectory: string; release: () => void }>(
          (resolve) => {
            resolveReservation = resolve;
          },
        ),
    );
    const next = { handle: vi.fn() };
    const interceptor = new TempUploadLifecycleInterceptor(
      { get: () => 1 } as never,
      { reserve } as never,
    );
    const context = {
      getHandler: () => () => undefined,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    };

    try {
      const intercepted = interceptor.intercept(
        context as never,
        next as never,
      );
      request.aborted = true;
      resolveReservation?.({ rootDirectory, release });

      await expect(intercepted).rejects.toBeInstanceOf(
        UploadStagingUnavailableException,
      );
      expect(release).toHaveBeenCalledTimes(1);
      expect(next.handle).not.toHaveBeenCalled();
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });
});
