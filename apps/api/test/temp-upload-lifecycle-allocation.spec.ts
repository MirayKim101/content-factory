import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  mkdtempSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  ...filesystem,
}));

import { TempUploadLifecycleInterceptor } from "../src/projects/presentation/temp-upload-lifecycle.interceptor.js";
import { UploadStagingUnavailableException } from "../src/projects/presentation/upload-staging-admission.service.js";

describe("TempUploadLifecycleInterceptor allocation cleanup", () => {
  it("removes a created request directory when chmod fails", async () => {
    filesystem.mkdtempSync.mockReturnValue("/fixture/uploads/request-created");
    filesystem.chmodSync.mockImplementation(() => {
      throw new Error("fixture chmod failure");
    });
    const release = vi.fn();
    const interceptor = new TempUploadLifecycleInterceptor(
      { get: () => 1 } as never,
      {
        reserve: vi.fn().mockResolvedValue({
          rootDirectory: "/fixture/uploads",
          release,
        }),
      } as never,
    );
    const request = Object.assign(new EventEmitter(), {
      aborted: false,
      destroyed: false,
    });
    const response = Object.assign(new EventEmitter(), { destroyed: false });

    await expect(
      interceptor.intercept(
        {
          getHandler: () => () => undefined,
          switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => response,
          }),
        } as never,
        { handle: vi.fn() } as never,
      ),
    ).rejects.toBeInstanceOf(UploadStagingUnavailableException);

    expect(filesystem.rmSync).toHaveBeenCalledWith(
      "/fixture/uploads/request-created",
      { force: true, recursive: true },
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
