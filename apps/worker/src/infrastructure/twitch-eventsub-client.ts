import { isIP } from "node:net";

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

  async listWebhookSubscriptions(
    signal?: AbortSignal,
  ): Promise<
    Array<{
      id: string;
      type: string;
      broadcasterId: string;
      callback: string;
      active: boolean;
    }>
  > {
    const result: Array<{
      id: string;
      type: string;
      broadcasterId: string;
      callback: string;
      active: boolean;
    }> = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      if (cursor && seen.has(cursor))
        throw new Error("TWITCH_EVENTSUB_CURSOR_CYCLE");
      if (cursor) seen.add(cursor);
      const url = new URL(EVENTSUB_ENDPOINT);
      if (cursor) url.searchParams.set("after", cursor);
      const response = await this.authorizedFetch(
        url,
        { method: "GET" },
        signal,
      );
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error(`TWITCH_EVENTSUB_LIST_${response.status}`);
      }
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
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!/^\d{1,64}$/.test(broadcasterId))
      throw new Error("TWITCH_BROADCASTER_ID_INVALID");
    const response = await this.authorizedFetch(
      EVENTSUB_ENDPOINT,
      {
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
      },
      signal,
    );
    const created = response.status === 202;
    const accepted = created || response.status === 409;
    await discardResponseBody(response);
    if (!accepted) throw new Error(`TWITCH_EVENTSUB_CREATE_${response.status}`);
    return created;
  }

  async deleteWebhookSubscription(
    id: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new Error("TWITCH_EVENTSUB_ID_INVALID");
    const url = new URL(EVENTSUB_ENDPOINT);
    url.searchParams.set("id", id);
    const response = await this.authorizedFetch(
      url,
      { method: "DELETE" },
      signal,
    );
    const accepted = response.status === 204 || response.status === 404;
    await discardResponseBody(response);
    if (!accepted) throw new Error(`TWITCH_EVENTSUB_DELETE_${response.status}`);
  }

  private async authorizedFetch(
    input: string | URL,
    init: RequestInit,
    signal?: AbortSignal,
  ) {
    let response = await this.requestWithToken(
      input,
      init,
      await this.accessToken.resolve(signal),
      signal,
    );
    if (response.status === 401 && this.accessToken.invalidate) {
      await discardResponseBody(response);
      this.accessToken.invalidate();
      response = await this.requestWithToken(
        input,
        init,
        await this.accessToken.resolve(signal),
        signal,
      );
    }
    return response;
  }

  private requestWithToken(
    input: string | URL,
    init: RequestInit,
    token: string,
    signal?: AbortSignal,
  ) {
    return this.request(input, {
      ...init,
      redirect: "error",
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        "Client-Id": this.clientId,
        Authorization: `Bearer ${token}`,
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function parseSubscriptionPage(value: unknown): {
  items: Array<{
    id: string;
    type: string;
    broadcasterId: string;
    callback: string;
    active: boolean;
  }>;
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
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) ||
      typeof row.status !== "string" ||
      typeof condition?.broadcaster_user_id !== "string" ||
      transport?.method !== "webhook" ||
      typeof transport.callback !== "string"
    )
      return [];
    return [
      {
        id: row.id,
        type: row.type,
        broadcasterId: condition.broadcaster_user_id,
        callback: transport.callback,
        active:
          row.status === "enabled" ||
          row.status === "webhook_callback_verification_pending",
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
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CONFIG_TWITCH_EVENTSUB_CALLBACK_URL_INVALID");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isNonPublicIp(hostname) ||
    url.pathname !== "/api/v1/twitch/eventsub"
  )
    throw new Error("CONFIG_TWITCH_EVENTSUB_CALLBACK_URL_INVALID");
  return url.toString();
}

function isNonPublicIp(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 0) return false;
  if (version === 6) {
    return (
      hostname === "::" ||
      hostname === "::1" ||
      /^f[cd]/.test(hostname) ||
      /^fe[89ab]/.test(hostname) ||
      hostname.startsWith("::ffff:")
    );
  }
  const octets = hostname.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}
