import { describe, expect, it, vi } from "vitest";

import { TikTokOAuthAccessTokenResolver } from "../src/infrastructure/tiktok-oauth-access-token-resolver.js";

const input = {
  channelId: "00000000-0000-4000-8000-000000000001",
  platform: "TIKTOK" as const,
  externalChannelRef: "723f24d7-e717-40f8-a2b6-cb8464cd23b4",
};

describe("TikTokOAuthAccessTokenResolver", () => {
  it("refreshes a scoped token and binds it to the immutable open_id", async () => {
    const signal = new AbortController().signal;
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access-token",
          expires_in: 86_400,
          open_id: input.externalChannelRef,
          scope: "user.info.basic,video.publish",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const resolver = new TikTokOAuthAccessTokenResolver(
      "client-key",
      "client-secret",
      [
        {
          externalChannelRef: input.externalChannelRef,
          refreshToken: "refresh-token",
        },
      ],
      request,
      () => 1_000,
    );
    await expect(resolver.resolve({ ...input, signal })).resolves.toBe(
      "access-token",
    );
    const body = request.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("client_secret")).toBe("client-secret");
    expect(String(request.mock.calls[0]![0])).not.toContain("client-secret");
    expect(request.mock.calls[0]![1]!.signal).toBe(signal);
    expect(request.mock.calls[0]![1]!.redirect).toBe("error");
  });

  it("rejects a token issued for another creator", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access-token",
          expires_in: 86_400,
          open_id: "different-user",
          scope: "video.publish",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const resolver = new TikTokOAuthAccessTokenResolver(
      "client-key",
      "client-secret",
      [
        {
          externalChannelRef: input.externalChannelRef,
          refreshToken: "refresh-token",
        },
      ],
      request,
    );
    await expect(resolver.resolve(input)).rejects.toThrow(
      "TIKTOK_TOKEN_RESPONSE_INVALID",
    );
  });

  it("rejects tokens without video.publish consent", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access-token",
          expires_in: 86_400,
          open_id: input.externalChannelRef,
          scope: "user.info.basic",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const resolver = new TikTokOAuthAccessTokenResolver(
      "client-key",
      "client-secret",
      [
        {
          externalChannelRef: input.externalChannelRef,
          refreshToken: "refresh-token",
        },
      ],
      request,
    );
    await expect(resolver.resolve(input)).rejects.toThrow(
      "TIKTOK_TOKEN_RESPONSE_INVALID",
    );
  });

  it("does not reuse a cached token after the external creator identity changes", async () => {
    const secondRef = "second-creator";
    const response = (accessToken: string, openId: string) =>
      new Response(
        JSON.stringify({
          access_token: accessToken,
          expires_in: 86_400,
          open_id: openId,
          scope: "video.publish",
        }),
      );
    const request = vi
      .fn()
      .mockResolvedValueOnce(response("first-token", input.externalChannelRef))
      .mockResolvedValueOnce(response("second-token", secondRef));
    const resolver = new TikTokOAuthAccessTokenResolver(
      "client-key",
      "client-secret",
      [
        {
          externalChannelRef: input.externalChannelRef,
          refreshToken: "first-refresh",
        },
        { externalChannelRef: secondRef, refreshToken: "second-refresh" },
      ],
      request,
      () => 1_000,
    );

    await expect(resolver.resolve(input)).resolves.toBe("first-token");
    await expect(
      resolver.resolve({ ...input, externalChannelRef: secondRef }),
    ).resolves.toBe("second-token");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
