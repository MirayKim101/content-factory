import type { TwitchEventSubProvider } from "../application/reconcile-twitch-eventsub.js";
import type { TwitchAccessTokenProvider } from "./twitch-helix-client.js";

const EVENTSUB_ENDPOINT = "https://api.twitch.tv/helix/eventsub/subscriptions";
const MAX_LIST_PAGES = 10;

export class TwitchEventSubClient implements TwitchEventSubProvider {
  private readonly callback: string;

  constructor(
    private readonly clientId: string,
    private readonly accessToken: TwitchAccessTokenProvider,
    callback: string,
    private readonly secret: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.callback = requirePublicHttpsCallback(callback);
    if (secret.length < 10 || secret.length > 100 || /[\r\n]/.test(secret))
      throw new Error("CONFIG_TWITCH_EVENTSUB_SECRET_INVALID");
  }

  async listWebhookSubscriptions(): Promise<
    Array<{ type: string; broadcasterId: string; callback: string }>
  > {
    const result: Array<{
      type: string;
      broadcasterId: string;
      callback: string;
    }> = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      if (cursor && seen.has(cursor))
        throw new Error("TWITCH_EVENTSUB_CURSOR_CYCLE");
      if (cursor) seen.add(cursor);
      const url = new URL(EVENTSUB_ENDPOINT);
      if (cursor) url.searchParams.set("after", cursor);
      const response = await this.authorizedFetch(url, { method: "GET" });
      if (!response.ok)
        throw new Error(`TWITCH_EVENTSUB_LIST_${response.status}`);
      const parsed = parseSubscriptionPage(await response.json());
      result.push(...parsed.items);
      cursor = parsed.nextCursor;
      if (!cursor) return result;
    }
    throw new Error("TWITCH_EVENTSUB_LIST_PAGE_LIMIT");
  }

  async createWebhookSubscription(
    type: "stream.online" | "stream.offline",
    broadcasterId: string,
  ): Promise<void> {
    if (!/^\d{1,64}$/.test(broadcasterId))
      throw new Error("TWITCH_BROADCASTER_ID_INVALID");
    const response = await this.authorizedFetch(EVENTSUB_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type,
        version: "1",
        condition: { broadcaster_user_id: broadcasterId },
        transport: {
          method: "webhook",
          callback: this.callback,
          secret: this.secret,
        },
      }),
    });
    if (response.status !== 202 && response.status !== 409)
      throw new Error(`TWITCH_EVENTSUB_CREATE_${response.status}`);
  }

  private async authorizedFetch(input: string | URL, init: RequestInit) {
    let response = await this.requestWithToken(
      input,
      init,
      await this.accessToken.resolve(),
    );
    if (response.status === 401 && this.accessToken.invalidate) {
      this.accessToken.invalidate();
      response = await this.requestWithToken(
        input,
        init,
        await this.accessToken.resolve(),
      );
    }
    return response;
  }

  private requestWithToken(
    input: string | URL,
    init: RequestInit,
    token: string,
  ) {
    return this.request(input, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        "Client-Id": this.clientId,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  }
}

function parseSubscriptionPage(value: unknown): {
  items: Array<{ type: string; broadcasterId: string; callback: string }>;
  nextCursor: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("TWITCH_EVENTSUB_RESPONSE_INVALID");
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.data))
    throw new Error("TWITCH_EVENTSUB_RESPONSE_INVALID");
  const items = payload.data.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    const condition = row.condition as Record<string, unknown> | undefined;
    const transport = row.transport as Record<string, unknown> | undefined;
    if (
      (row.type !== "stream.online" && row.type !== "stream.offline") ||
      (row.status !== "enabled" &&
        row.status !== "webhook_callback_verification_pending") ||
      typeof condition?.broadcaster_user_id !== "string" ||
      transport?.method !== "webhook" ||
      typeof transport.callback !== "string"
    )
      return [];
    return [
      {
        type: row.type,
        broadcasterId: condition.broadcaster_user_id,
        callback: transport.callback,
      },
    ];
  });
  const pagination = payload.pagination as Record<string, unknown> | undefined;
  const cursor = pagination?.cursor;
  if (cursor !== undefined && typeof cursor !== "string")
    throw new Error("TWITCH_EVENTSUB_RESPONSE_INVALID");
  return { items, nextCursor: cursor?.trim() || null };
}

function requirePublicHttpsCallback(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1"
  )
    throw new Error("CONFIG_TWITCH_EVENTSUB_CALLBACK_URL_INVALID");
  return url.toString();
}
