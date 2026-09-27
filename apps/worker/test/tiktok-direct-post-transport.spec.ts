import { describe, expect, it, vi } from "vitest";

import { TikTokDirectPostTransport } from "../src/infrastructure/tiktok-direct-post-transport.js";

const ok = (data: object) =>
  new Response(
    JSON.stringify({ data, error: { code: "ok", message: "", log_id: "log" } }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

describe("TikTokDirectPostTransport", () => {
  it("queries the latest creator capabilities", async () => {
    const request = vi.fn().mockResolvedValue(
      ok({
        creator_avatar_url: "https://example.test/avatar.png",
        creator_nickname: "Creator",
        creator_username: "creator",
        privacy_level_options: ["SELF_ONLY"],
        comment_disabled: false,
        duet_disabled: true,
        stitch_disabled: false,
        max_video_post_duration_sec: 600,
      }),
    );
    await expect(
      new TikTokDirectPostTransport(request).creatorInfo("token"),
    ).resolves.toMatchObject({
      creatorUsername: "creator",
      privacyLevelOptions: ["SELF_ONLY"],
      maxVideoPostDurationSec: 600,
    });
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("creator_info/query"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer token" }),
      }),
    );
  });

  it("plans compliant chunks and initializes a direct post", async () => {
    const request = vi.fn().mockResolvedValue(
      ok({
        publish_id: "publish_42",
        upload_url:
          "https://upload.us.tiktokapis.com/video/?upload_id=42&upload_token=secret",
      }),
    );
    const transport = new TikTokDirectPostTransport(request);
    const result = await transport.initiate({
      accessToken: "token",
      totalBytes: 70n * 1024n * 1024n,
      title: "Release",
      privacyLevel: "SELF_ONLY",
      disableComment: false,
      disableDuet: true,
      disableStitch: true,
      brandContentToggle: false,
      brandOrganicToggle: false,
    });
    expect(result.plan).toEqual({
      chunkSize: 64 * 1024 * 1024,
      totalChunkCount: 1,
    });
    expect(result.publishId).toBe("publish_42");
    const body = JSON.parse(String(request.mock.calls[0]![1]!.body));
    expect(body.source_info).toMatchObject({
      source: "FILE_UPLOAD",
      total_chunk_count: 1,
    });
  });

  it("uploads ranges sequentially with provider response semantics", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 206 }));
    await expect(
      new TikTokDirectPostTransport(request).uploadChunk({
        uploadUrl: "https://open-upload.tiktokapis.com/video/?upload_id=42",
        chunk: new Uint8Array(5),
        offset: 0n,
        totalBytes: 10n,
        contentType: "video/mp4",
        final: false,
      }),
    ).resolves.toEqual({ complete: false, nextOffset: 5n });
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("open-upload.tiktokapis.com"),
      expect.objectContaining({
        headers: expect.objectContaining({ "content-range": "bytes 0-4/10" }),
      }),
    );
  });

  it("rejects upload capabilities outside TikTok hosts", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        ok({
          publish_id: "publish_42",
          upload_url: "https://attacker.example/video",
        }),
      );
    await expect(
      new TikTokDirectPostTransport(request).initiate({
        accessToken: "token",
        totalBytes: 1n,
        title: "x",
        privacyLevel: "SELF_ONLY",
        disableComment: false,
        disableDuet: false,
        disableStitch: false,
        brandContentToggle: false,
        brandOrganicToggle: false,
      }),
    ).rejects.toThrow("TIKTOK_UPLOAD_URL_INVALID");
  });

  it("maps provider processing status without trusting arbitrary values", async () => {
    const request = vi.fn().mockResolvedValue(
      ok({
        status: "PUBLISH_COMPLETE",
        publicaly_available_post_id: [12345],
        uploaded_bytes: 100,
      }),
    );
    await expect(
      new TikTokDirectPostTransport(request).status({
        accessToken: "token",
        publishId: "publish_42",
      }),
    ).resolves.toEqual({
      status: "PUBLISH_COMPLETE",
      postIds: ["12345"],
      uploadedBytes: 100n,
    });
  });
});
