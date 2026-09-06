import { describe, expect, it, vi } from "vitest";

import {
  createMontageAssetsApi,
  MontageAssetsAbortError,
} from "~/shared/api/montage-assets";

describe("montage assets API upload", () => {
  it("loads every cursor page so a persisted selector can retain asset 51", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const item = (index: number) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      projectId,
      sourceId: "00000000-0000-4000-8000-000000000002",
      sourceVersion: 1,
      kind: "BANNER",
      status: "READY",
      revision: 1,
      originalFilename: `banner-${index}.png`,
      contentType: "image/png",
      sizeBytes: "1",
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
      durationMs: null,
      hasAudio: null,
      probeJobId: null,
      probe: null,
      failure: null,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    });
    const first = Array.from({ length: 50 }, (_, index) => item(index + 1));
    const last = item(51);
    const fetchImplementation = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("cursor=cursor-50")
              ? { items: [last], nextCursor: null }
              : { items: first, nextCursor: "cursor-50" },
          ),
          { status: 200 },
        ),
    );
    const api = createMontageAssetsApi({
      apiBasePath: "/api/v1",
      fetchImplementation,
    });
    const assets = await api.list(projectId, "BANNER");
    expect(assets).toHaveLength(51);
    expect(assets.at(-1)?.id).toBe(last.id);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

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
