import { describe, expect, it, vi } from "vitest";

import { HttpTwitchVodMediaProvider } from "../src/infrastructure/http-twitch-vod-media-provider.js";

describe("HttpTwitchVodMediaProvider", () => {
  it("opens a bounded initial MP4 response without redirects", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "video/mp4", "content-length": "3" },
        }),
    );
    const provider = new HttpTwitchVodMediaProvider(
      {
        baseUrl: "https://media.example.test",
        bearerToken: "secret",
        timeoutMs: 5_000,
      },
      fetcher,
    );
    await expect(provider.open("123", 0n)).resolves.toMatchObject({
      totalSizeBytes: 3n,
      offset: 0n,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://media.example.test/v1/twitch/vods/123/media",
      expect.objectContaining({
        redirect: "error",
        headers: { authorization: "Bearer secret" },
      }),
    );
  });

  it("requires an exact range response when resuming", async () => {
    let captured: RequestInit | undefined;
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        captured = init;
        return new Response(new Uint8Array([3, 4]), {
          status: 206,
          headers: {
            "content-type": "video/mp4",
            "content-length": "2",
            "content-range": "bytes 2-3/4",
          },
        });
      },
    );
    const provider = new HttpTwitchVodMediaProvider(
      {
        baseUrl: "https://media.example.test",
        bearerToken: "secret",
        timeoutMs: 5_000,
      },
      fetcher,
    );
    await expect(provider.open("123", 2n)).resolves.toMatchObject({
      totalSizeBytes: 4n,
      offset: 2n,
    });
    expect(captured?.headers).toMatchObject({
      range: "bytes=2-",
    });
  });

  it("rejects ignored ranges and media type confusion", async () => {
    const cancel = vi.fn();
    const ignoredRange = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel,
          }),
          {
            headers: {
              "content-type": "video/mp4",
              "content-length": "1",
            },
          },
        ),
    );
    const provider = new HttpTwitchVodMediaProvider(
      {
        baseUrl: "https://media.example.test",
        bearerToken: "secret",
        timeoutMs: 5_000,
      },
      ignoredRange,
    );
    await expect(provider.open("123", 1n)).rejects.toThrow(
      "TWITCH_VOD_MEDIA_RANGE_UNSUPPORTED",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels rejected HTTP response bodies so gateway connections are reusable", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel,
          }),
          { status: 503 },
        ),
    );
    const provider = new HttpTwitchVodMediaProvider(
      {
        baseUrl: "https://media.example.test",
        bearerToken: "secret",
        timeoutMs: 5_000,
      },
      fetcher,
    );

    await expect(provider.open("123", 0n)).rejects.toThrow(
      "TWITCH_VOD_MEDIA_HTTP_503",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
