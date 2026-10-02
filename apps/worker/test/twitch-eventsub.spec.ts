import { describe, expect, it, vi } from "vitest";

import { ReconcileTwitchEventSub } from "../src/application/reconcile-twitch-eventsub.js";
import { TwitchEventSubClient } from "../src/infrastructure/twitch-eventsub-client.js";

const callback = "https://content.example.com/api/v1/twitch/eventsub";

describe("Twitch EventSub reconciliation", () => {
  it("creates only missing online/offline subscriptions and deduplicates channels", async () => {
    const provider = {
      listWebhookSubscriptions: vi.fn(async () => [
        {
          id: "sub-online",
          type: "stream.online",
          broadcasterId: "1337",
          callback,
        },
        {
          id: "sub-revoked",
          type: "stream.offline",
          broadcasterId: "9999",
          callback,
        },
      ]),
      createWebhookSubscription: vi.fn(async () => true),
      deleteWebhookSubscription: vi.fn(async () => undefined),
    };

    await expect(
      new ReconcileTwitchEventSub(provider, callback).execute([
        "1337",
        "1337",
        "7331",
      ]),
    ).resolves.toEqual({ created: 3, deleted: 1 });
    expect(provider.createWebhookSubscription.mock.calls).toEqual([
      ["stream.offline", "1337", undefined],
      ["stream.online", "7331", undefined],
      ["stream.offline", "7331", undefined],
    ]);
    expect(provider.deleteWebhookSubscription).toHaveBeenCalledWith(
      "sub-revoked",
      undefined,
    );
  });

  it("recreates every managed subscription during a secret rotation", async () => {
    const progress = vi.fn(async () => undefined);
    const provider = {
      listWebhookSubscriptions: vi.fn(async () => [
        {
          id: "old-online",
          type: "stream.online",
          broadcasterId: "1337",
          callback,
        },
        {
          id: "old-offline",
          type: "stream.offline",
          broadcasterId: "1337",
          callback,
        },
      ]),
      createWebhookSubscription: vi.fn(async () => true),
      deleteWebhookSubscription: vi.fn(async () => undefined),
    };

    await expect(
      new ReconcileTwitchEventSub(provider, callback).execute(
        ["1337"],
        undefined,
        { recreateAll: true, onProgress: progress },
      ),
    ).resolves.toEqual({ created: 2, deleted: 2 });
    expect(provider.deleteWebhookSubscription.mock.calls).toEqual([
      ["old-online", undefined],
      ["old-offline", undefined],
    ]);
    expect(provider.createWebhookSubscription).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledTimes(9);
  });

  it("does not commit a rotation when Twitch reports an existing subscription", async () => {
    const provider = {
      listWebhookSubscriptions: vi.fn(async () => []),
      createWebhookSubscription: vi.fn(async () => false),
      deleteWebhookSubscription: vi.fn(async () => undefined),
    };

    await expect(
      new ReconcileTwitchEventSub(provider, callback).execute(
        ["1337"],
        undefined,
        { recreateAll: true },
      ),
    ).rejects.toThrow("TWITCH_EVENTSUB_ROTATION_CONFLICT");
  });

  it("propagates shutdown abort into an active EventSub request", async () => {
    const request = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new TwitchEventSubClient(
      "client-id",
      { resolve: async () => "app-token" },
      callback,
      "eventsub-secret-value",
      request as typeof fetch,
    );
    const controller = new AbortController();

    const pending = client.listWebhookSubscriptions(controller.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort(new Error("TWITCH_WORKER_SHUTDOWN"));

    await expect(pending).rejects.toThrow("TWITCH_WORKER_SHUTDOWN");
  });

  it("removes failed subscriptions before recreating the missing events", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "failed-online",
              type: "stream.online",
              version: "1",
              status: "notification_failures_exceeded",
              condition: { broadcaster_user_id: "1337" },
              transport: { method: "webhook", callback },
            },
          ],
          pagination: {},
        }),
      ),
    );
    const client = new TwitchEventSubClient(
      "client-id",
      { resolve: async () => "app-token" },
      callback,
      "eventsub-secret-value",
      request,
    );
    const subscriptions = await client.listWebhookSubscriptions();
    expect(subscriptions[0]).toMatchObject({
      id: "failed-online",
      active: false,
    });
    const calls: string[] = [];
    const provider = {
      listWebhookSubscriptions: async () => subscriptions,
      deleteWebhookSubscription: async (id: string) => {
        calls.push(`delete:${id}`);
      },
      createWebhookSubscription: async (type: string) => {
        calls.push(`create:${type}`);
        return true;
      },
    };
    await expect(
      new ReconcileTwitchEventSub(provider, callback).execute(["1337"]),
    ).resolves.toEqual({ created: 2, deleted: 1 });
    expect(calls).toEqual([
      "delete:failed-online",
      "create:stream.online",
      "create:stream.offline",
    ]);
  });

  it("uses bounded official webhook payloads and keeps the secret out of the URL", async () => {
    const createCancel = vi.fn();
    const request = vi
      .fn((_input: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(new Response()),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], pagination: {} }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: createCancel }), {
          status: 202,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
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
    ).resolves.toBe(true);
    expect(createCancel).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[1]!;
    expect(String(url)).not.toContain("eventsub-secret-value");
    expect(init?.redirect).toBe("error");
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
    await expect(
      client.deleteWebhookSubscription("subscription_123"),
    ).resolves.toBeUndefined();
    expect(String(request.mock.calls[2]![0])).toContain("id=subscription_123");
    expect(request.mock.calls[2]![1]?.method).toBe("DELETE");
  });

  it.each([
    "not-a-url",
    "http://127.0.0.1:3001/api/v1/twitch/eventsub",
    "https://10.0.0.5/api/v1/twitch/eventsub",
    "https://172.20.0.5/api/v1/twitch/eventsub",
    "https://192.168.1.5/api/v1/twitch/eventsub",
    "https://[::1]/api/v1/twitch/eventsub",
    "https://[fd00::1]/api/v1/twitch/eventsub",
    "https://content.example.com/not-our-webhook",
  ])("rejects a non-public or incorrectly routed callback: %s", (url) => {
    expect(
      () =>
        new TwitchEventSubClient(
          "client-id",
          { resolve: async () => "token" },
          url,
          "eventsub-secret-value",
        ),
    ).toThrow("CONFIG_TWITCH_EVENTSUB_CALLBACK_URL_INVALID");
  });
});
