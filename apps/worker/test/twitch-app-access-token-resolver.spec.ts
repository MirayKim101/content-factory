import { describe, expect, it, vi } from "vitest";

import { TwitchAppAccessTokenResolver } from "../src/infrastructure/twitch-app-access-token-resolver.js";

describe("TwitchAppAccessTokenResolver", () => {
  it("coalesces acquisition and caches the token before its expiry skew", async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: "app-token",
            expires_in: 3600,
            token_type: "bearer",
          }),
          { status: 200 },
        ),
    );
    const resolver = new TwitchAppAccessTokenResolver(
      "client-id",
      "client-secret",
      request as typeof fetch,
      () => 1_000,
    );

    const [first, second] = await Promise.all([
      resolver.resolve(),
      resolver.resolve(),
    ]);
    const third = await resolver.resolve();

    expect([first, second, third]).toEqual([
      "app-token",
      "app-token",
      "app-token",
    ]);
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://id.twitch.tv/oauth2/token");
    expect(url).not.toContain("client-secret");
    expect(String(init?.body)).toContain("client_secret=client-secret");
    expect(String(init?.body)).toContain("grant_type=client_credentials");
    expect(init?.redirect).toBe("error");
  });

  it("does not cache failed or malformed responses", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "bad", expires_in: 10 }), {
          status: 200,
        }),
      );
    const resolver = new TwitchAppAccessTokenResolver(
      "client-id",
      "client-secret",
      request as typeof fetch,
    );

    await expect(resolver.resolve()).rejects.toThrow("TWITCH_OAUTH_503");
    await expect(resolver.resolve()).rejects.toThrow(
      "TWITCH_OAUTH_RESPONSE_INVALID",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts active token acquisition during worker shutdown", async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const resolver = new TwitchAppAccessTokenResolver(
      "client-id",
      "client-secret",
      request as typeof fetch,
    );
    const controller = new AbortController();
    const pending = resolver.resolve(controller.signal);

    controller.abort(new Error("worker shutdown"));

    await expect(pending).rejects.toThrow("worker shutdown");
    expect(request).toHaveBeenCalledOnce();
  });
});
