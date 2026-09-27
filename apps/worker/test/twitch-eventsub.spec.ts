import { describe, expect, it, vi } from "vitest";

import { ReconcileTwitchEventSub } from "../src/application/reconcile-twitch-eventsub.js";
import { TwitchEventSubClient } from "../src/infrastructure/twitch-eventsub-client.js";

const callback = "https://content.example.com/api/v1/twitch/eventsub";

describe("Twitch EventSub reconciliation", () => {
  it("creates only missing online/offline subscriptions and deduplicates channels", async () => {
    const provider = {
      listWebhookSubscriptions: vi.fn(async () => [
        { type: "stream.online", broadcasterId: "1337", callback },
      ]),
      createWebhookSubscription: vi.fn(async () => undefined),
    };

    await expect(
      new ReconcileTwitchEventSub(provider, callback).execute([
        "1337",
        "1337",
        "7331",
      ]),
    ).resolves.toBe(3);
    expect(provider.createWebhookSubscription.mock.calls).toEqual([
      ["stream.offline", "1337"],
      ["stream.online", "7331"],
      ["stream.offline", "7331"],
    ]);
  });

  it("uses bounded official webhook payloads and keeps the secret out of the URL", async () => {
    const request = vi
      .fn((_input: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response()),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], pagination: {} }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    const client = new TwitchEventSubClient(
      "client-id",
      { resolve: async () => "app-token" },
      callback,
      "eventsub-secret-value",
      request as typeof fetch,
    );

    await expect(client.listWebhookSubscriptions()).resolves.toEqual([]);
    await expect(
      client.createWebhookSubscription("stream.online", "1337"),
    ).resolves.toBeUndefined();
    const [url, init] = request.mock.calls[1]!;
    expect(String(url)).not.toContain("eventsub-secret-value");
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "stream.online",
      version: "1",
      condition: { broadcaster_user_id: "1337" },
      transport: {
        method: "webhook",
        callback,
        secret: "eventsub-secret-value",
      },
    });
  });

  it("rejects callbacks that are not public HTTPS on the default port", () => {
    expect(
      () =>
        new TwitchEventSubClient(
          "client-id",
          { resolve: async () => "token" },
          "http://127.0.0.1:3001/api/v1/twitch/eventsub",
          "eventsub-secret-value",
        ),
    ).toThrow("CONFIG_TWITCH_EVENTSUB_CALLBACK_URL_INVALID");
  });
});
