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
      chunkSize: 35 * 1024 * 1024,
      totalChunkCount: 2,
    });
    expect(result.publishId).toBe("publish_42");
    const body = JSON.parse(String(request.mock.calls[0]![1]!.body));
    expect(body.source_info).toMatchObject({
      source: "FILE_UPLOAD",
      total_chunk_count: 2,
    });
  });

  it("uploads ranges sequentially with provider response semantics", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 206 }));
    const chunkSize = 5 * 1024 * 1024;
    await expect(
      new TikTokDirectPostTransport(request).uploadChunk({
        uploadUrl: "https://open-upload.tiktokapis.com/video/?upload_id=42",
        chunk: new Uint8Array(chunkSize),
        offset: 0n,
        totalBytes: BigInt(chunkSize * 2),
        contentType: "video/mp4",
        final: false,
      }),
    ).resolves.toEqual({ complete: false, nextOffset: BigInt(chunkSize) });
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("open-upload.tiktokapis.com"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "content-range": `bytes 0-${chunkSize - 1}/${chunkSize * 2}`,
        }),
      }),
    );
  });

  it("rejects non-final chunks outside TikTok transfer bounds", async () => {
    const request = vi.fn();
    await expect(
      new TikTokDirectPostTransport(request).uploadChunk({
        uploadUrl: "https://open-upload.tiktokapis.com/video/?upload_id=42",
        chunk: new Uint8Array(1024),
        offset: 0n,
        totalBytes: 10n * 1024n * 1024n,
        contentType: "video/mp4",
        final: false,
      }),
    ).rejects.toThrow("TIKTOK_UPLOAD_CHUNK_SIZE_INVALID");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects upload capabilities outside TikTok hosts", async () => {
    const request = vi.fn().mockResolvedValue(
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

  it("queries metrics for the exact published post", async () => {
    const request = vi.fn().mockResolvedValue(
      ok({
        videos: [
          {
            id: "12345",
            view_count: 101,
            like_count: 12,
            comment_count: 3,
            share_count: 4,
          },
        ],
      }),
    );

    await expect(
      new TikTokDirectPostTransport(request).metrics({
        accessToken: "token",
        videoId: "12345",
      }),
    ).resolves.toEqual({
      viewCount: 101n,
      likeCount: 12n,
      commentCount: 3n,
      shareCount: 4n,
    });
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("/v2/video/query/"),
      expect.objectContaining({ body: JSON.stringify({ filters: { video_ids: ["12345"] } }) }),
    );
  });
});
