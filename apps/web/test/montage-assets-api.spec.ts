import { describe, expect, it, vi } from "vitest";

import {
  createMontageAssetsApi,
  MontageAssetsAbortError,
} from "~/shared/api/montage-assets";

describe("montage assets API upload", () => {
  it("rejects an already aborted request without constructing or sending XHR", async () => {
    const createRequest = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const api = createMontageAssetsApi({
      apiBasePath: "/api/v1",
      xmlHttpRequestFactory: createRequest,
    });

    await expect(
      api.upload({
        projectId: "00000000-0000-4000-8000-000000000001",
        kind: "INTRO",
        file: new File(["video"], "intro.mp4", { type: "video/mp4" }),
        idempotencyKey: "web-montage-pre-aborted",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(MontageAssetsAbortError);
    expect(createRequest).not.toHaveBeenCalled();
  });

  it("keeps a synchronous XHR onabort as a controlled cancellation", async () => {
    const controller = new AbortController();
    const xhr = {
      upload: {},
      responseText: "",
      status: 0,
      onerror: undefined as (() => void) | undefined,
      onabort: undefined as (() => void) | undefined,
      onload: undefined as (() => void) | undefined,
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(() => controller.abort()),
      abort: vi.fn(function (this: { onabort?: () => void }) {
        this.onabort?.();
      }),
    };
    const api = createMontageAssetsApi({
      apiBasePath: "/api/v1",
      xmlHttpRequestFactory: () => xhr as unknown as XMLHttpRequest,
    });

    await expect(
      api.upload({
        projectId: "00000000-0000-4000-8000-000000000001",
        kind: "INTRO",
        file: new File(["video"], "intro.mp4", { type: "video/mp4" }),
        idempotencyKey: "web-montage-sync-abort",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(MontageAssetsAbortError);
    expect(xhr.abort).toHaveBeenCalledTimes(1);
  });
});
