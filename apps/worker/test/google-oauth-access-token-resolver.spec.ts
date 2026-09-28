import { describe, expect, it, vi } from "vitest";

import { GoogleOAuthAccessTokenResolver } from "../src/infrastructure/google-oauth-access-token-resolver.js";

const channelId = "00000000-0000-4000-8000-000000000001";
const externalChannelRef = "UC1234567890123456789012";

describe("GoogleOAuthAccessTokenResolver", () => {
  it("refreshes a token, verifies channel ownership, and caches it", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: externalChannelRef }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const resolver = new GoogleOAuthAccessTokenResolver(
      "client-id",
      "client-secret",
      [{ channelId, externalChannelRef, refreshToken: "refresh-token" }],
      request,
      () => 1_000,
    );
    const input = {
      channelId,
      platform: "YOUTUBE" as const,
      externalChannelRef,
      signal: new AbortController().signal,
    };

    await expect(resolver.resolve(input)).resolves.toBe("access-token");
    await expect(resolver.resolve(input)).resolves.toBe("access-token");

    expect(request).toHaveBeenCalledTimes(2);
    const tokenRequest = request.mock.calls[0]![1]!;
    expect(tokenRequest.redirect).toBe("error");
    expect(String(tokenRequest.body)).toContain("refresh_token=refresh-token");
    expect(String(tokenRequest.body)).toContain("client_secret=client-secret");
    expect(tokenRequest.signal).toBeInstanceOf(AbortSignal);
    expect(tokenRequest.signal).not.toBe(input.signal);
    expect(request.mock.calls[1]![1]!.signal).toBeInstanceOf(AbortSignal);
    expect(request.mock.calls[1]![1]!.redirect).toBe("error");
  });

  it("rejects a valid token for a different YouTube channel", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ items: [{ id: "UC9999999999999999999999" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const resolver = new GoogleOAuthAccessTokenResolver(
      "client-id",
      "client-secret",
      [{ channelId, externalChannelRef, refreshToken: "refresh-token" }],
      request,
    );

    await expect(
      resolver.resolve({ channelId, platform: "YOUTUBE", externalChannelRef }),
    ).rejects.toThrow("YOUTUBE_CHANNEL_IDENTITY_MISMATCH");
  });

  it("does not call OAuth for an unbound application channel", async () => {
    const request = vi.fn();
    const resolver = new GoogleOAuthAccessTokenResolver(
      "client-id",
      "client-secret",
      [{ channelId, externalChannelRef, refreshToken: "refresh-token" }],
      request,
    );

    await expect(
      resolver.resolve({
        channelId: "00000000-0000-4000-8000-000000000002",
        platform: "YOUTUBE",
        externalChannelRef,
      }),
    ).rejects.toThrow("YOUTUBE_CHANNEL_CREDENTIAL_UNAVAILABLE");
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels a rejected token response", async () => {
    const cancel = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(new ReadableStream({ cancel }), { status: 503 }),
      );
    const resolver = new GoogleOAuthAccessTokenResolver(
      "client-id",
      "client-secret",
      [{ channelId, externalChannelRef, refreshToken: "refresh-token" }],
      request,
    );

    await expect(
      resolver.resolve({ channelId, platform: "YOUTUBE", externalChannelRef }),
    ).rejects.toThrow("YOUTUBE_TOKEN_REFRESH_FAILED_503");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates publication shutdown into a bounded credential request", async () => {
    const request = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
    );
    const resolver = new GoogleOAuthAccessTokenResolver(
      "client-id",
      "client-secret",
      [{ channelId, externalChannelRef, refreshToken: "refresh-token" }],
      request,
    );
    const controller = new AbortController();
    const pending = resolver.resolve({
      channelId,
      platform: "YOUTUBE",
      externalChannelRef,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort(new Error("publication shutdown"));

    await expect(pending).rejects.toThrow("publication shutdown");
  });

  it("does not reuse a cached token after the external channel identity changes", async () => {
    const secondRef = "UCabcdefghijklmnopqrstuv";
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "first-token", expires_in: 3600 }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: externalChannelRef }] })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "second-token", expires_in: 3600 }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: secondRef }] })),
      );
    const resolver = new GoogleOAuthAccessTokenResolver(
      "client-id",
      "client-secret",
      [
        { externalChannelRef, refreshToken: "first-refresh" },
        { externalChannelRef: secondRef, refreshToken: "second-refresh" },
      ],
      request,
      () => 1_000,
    );

    await expect(
      resolver.resolve({ channelId, platform: "YOUTUBE", externalChannelRef }),
    ).resolves.toBe("first-token");
    await expect(
      resolver.resolve({
        channelId,
        platform: "YOUTUBE",
        externalChannelRef: secondRef,
      }),
    ).resolves.toBe("second-token");
    expect(request).toHaveBeenCalledTimes(4);
  });
});
