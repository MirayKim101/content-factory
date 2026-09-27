import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GetTikTokCreatorInfo,
  queryTikTokCreatorInfo,
} from "../src/publishing/application/get-tiktok-creator-info.js";
import { TikTokCreatorInfoUnavailableError } from "../src/publishing/domain/publication.js";

const input = {
  clientKey: "client-key",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  expectedOpenId: "723f24d7-e717-40f8-a2b6-cb8464cd23b4",
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PUBLISHING_ENABLED;
  delete process.env.TIKTOK_PUBLISHING_ENABLED;
  delete process.env.TIKTOK_CLIENT_KEY;
  delete process.env.TIKTOK_CLIENT_SECRET;
  delete process.env.TIKTOK_CHANNEL_CREDENTIALS_JSON;
});

describe("queryTikTokCreatorInfo", () => {
  it("verifies token identity and returns bounded creator capabilities", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            open_id: input.expectedOpenId,
            scope: "video.publish,user.info.basic",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              creator_avatar_url: "https://example.test/avatar",
              creator_nickname: "Creator",
              creator_username: "creator",
              privacy_level_options: ["SELF_ONLY"],
              comment_disabled: false,
              duet_disabled: true,
              stitch_disabled: false,
              max_video_post_duration_sec: 600,
            },
            error: { code: "ok", message: "", log_id: "log" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    await expect(
      queryTikTokCreatorInfo(
        input,
        request,
        new Date("2026-09-28T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      creatorUsername: "creator",
      privacyLevelOptions: ["SELF_ONLY"],
      fetchedAt: "2026-09-28T00:00:00.000Z",
    });
    expect(String(request.mock.calls[0]![0])).not.toContain("client-secret");
    expect(request.mock.calls[1]![1]?.headers).toMatchObject({
      authorization: "Bearer access-token",
    });
  });

  it("fails closed when OAuth identity does not match the channel", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access-token",
          open_id: "another-user",
          scope: "video.publish",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      queryTikTokCreatorInfo(input, request, new Date()),
    ).rejects.toBeInstanceOf(TikTokCreatorInfoUnavailableError);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("GetTikTokCreatorInfo", () => {
  it("coalesces concurrent requests and briefly caches successful capabilities", async () => {
    process.env.PUBLISHING_ENABLED = "1";
    process.env.TIKTOK_PUBLISHING_ENABLED = "1";
    process.env.TIKTOK_CLIENT_KEY = input.clientKey;
    process.env.TIKTOK_CLIENT_SECRET = input.clientSecret;
    process.env.TIKTOK_CHANNEL_CREDENTIALS_JSON = JSON.stringify([
      {
        channelId: "b7344738-b464-42f2-9412-26445a2ab78f",
        externalChannelRef: input.expectedOpenId,
        refreshToken: input.refreshToken,
      },
    ]);
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            open_id: input.expectedOpenId,
            scope: "video.publish",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              creator_avatar_url: "https://example.test/avatar",
              creator_nickname: "Creator",
              creator_username: "creator",
              privacy_level_options: ["SELF_ONLY"],
              comment_disabled: false,
              duet_disabled: false,
              stitch_disabled: false,
              max_video_post_duration_sec: 600,
            },
            error: { code: "ok" },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", request);
    const prisma = {
      publicationChannel: {
        findFirst: vi.fn().mockResolvedValue({
          externalChannelRef: input.expectedOpenId,
        }),
      },
    };
    const service = new GetTikTokCreatorInfo(prisma as never);
    const args = [
      "a07fcf84-4ecf-49d1-ab00-924b63902449",
      "b7344738-b464-42f2-9412-26445a2ab78f",
    ] as const;

    const [first, second] = await Promise.all([
      service.execute(...args),
      service.execute(...args),
    ]);
    const third = await service.execute(...args);

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(request).toHaveBeenCalledTimes(2);
    expect(prisma.publicationChannel.findFirst).toHaveBeenCalledTimes(3);
  });
});
