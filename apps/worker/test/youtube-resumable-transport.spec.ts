import { describe, expect, it, vi } from "vitest";

import { YoutubeResumableTransport } from "../src/infrastructure/youtube-resumable-transport.js";

describe("YoutubeResumableTransport", () => {
  it("starts an authenticated resumable upload without exposing token in URL", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          location: "https://www.googleapis.com/upload/youtube/session-42",
        },
      }),
    );
    const transport = new YoutubeResumableTransport(request);

    await expect(
      transport.initiate({
        accessToken: "secret-token",
        totalBytes: 1024n,
        contentType: "video/mp4",
        metadata: { snippet: { title: "Release" } },
      }),
    ).resolves.toBe("https://www.googleapis.com/upload/youtube/session-42");

    expect(request).toHaveBeenCalledWith(
      expect.not.stringContaining("secret-token"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret-token",
          "x-upload-content-length": "1024",
        }),
      }),
    );
  });

  it("parses committed offsets and final video receipts", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 308,
          headers: { range: "bytes=0-524287" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "video_42" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const transport = new YoutubeResumableTransport(request);
    const common = {
      sessionUrl: "https://upload.youtube.com/resumable/session-42",
      accessToken: "token",
      totalBytes: 1_048_576n,
      contentType: "video/mp4",
    };

    await expect(
      transport.uploadChunk({
        ...common,
        chunk: new Uint8Array(524_288),
        offset: 0n,
      }),
    ).resolves.toEqual({ state: "INCOMPLETE", nextOffset: 524_288n });
    await expect(
      transport.uploadChunk({
        ...common,
        chunk: new Uint8Array(524_288),
        offset: 524_288n,
      }),
    ).resolves.toEqual({ state: "COMPLETE", videoId: "video_42" });
  });

  it("rejects redirected capability URLs outside the provider allowlist", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { location: "https://attacker.example/upload" },
      }),
    );

    await expect(
      new YoutubeResumableTransport(request).initiate({
        accessToken: "token",
        totalBytes: 1n,
        contentType: "video/mp4",
        metadata: {},
      }),
    ).rejects.toThrow("YOUTUBE_UPLOAD_SESSION_INVALID");
  });

  it("probes an ambiguous session before any retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 308, headers: { range: "bytes=0-9" } }),
      );

    await expect(
      new YoutubeResumableTransport(request).probe({
        sessionUrl: "https://www.googleapis.com/upload/session",
        accessToken: "token",
        totalBytes: 20n,
      }),
    ).resolves.toEqual({ state: "INCOMPLETE", nextOffset: 10n });
  });
});
