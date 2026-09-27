import type { PublicationAccessTokenResolver } from "../application/publication-credential.port.js";

const TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";

export interface TikTokChannelCredential {
  channelId?: string;
  externalChannelRef: string;
  refreshToken: string;
}

type CachedToken = { accessToken: string; expiresAtMs: number };

export class TikTokOAuthAccessTokenResolver implements PublicationAccessTokenResolver {
  private readonly credentials = new Map<string, TikTokChannelCredential>();
  private readonly cache = new Map<string, CachedToken>();

  constructor(
    private readonly clientKey: string,
    private readonly clientSecret: string,
    credentials: readonly TikTokChannelCredential[],
    private readonly request: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    secret(clientKey, "TIKTOK_CLIENT_KEY_INVALID");
    secret(clientSecret, "TIKTOK_CLIENT_SECRET_INVALID");
    for (const credential of credentials) {
      secret(credential.refreshToken, "TIKTOK_REFRESH_TOKEN_INVALID");
      if (
        (credential.channelId !== undefined && !uuidV4(credential.channelId)) ||
        !openId(credential.externalChannelRef) ||
        this.credentials.has(credential.externalChannelRef)
      )
        throw new Error("TIKTOK_CHANNEL_CREDENTIAL_INVALID");
      this.credentials.set(credential.externalChannelRef, { ...credential });
    }
  }

  async resolve(input: {
    channelId: string;
    platform: "LOCAL_DRY_RUN" | "YOUTUBE" | "TIKTOK";
    externalChannelRef: string;
    signal?: AbortSignal;
  }): Promise<string> {
    if (input.platform !== "TIKTOK")
      throw new Error("TIKTOK_CREDENTIAL_PLATFORM_MISMATCH");
    const credential = this.credentials.get(input.externalChannelRef);
    if (
      !credential ||
      (credential.channelId && credential.channelId !== input.channelId)
    )
      throw new Error("TIKTOK_CHANNEL_CREDENTIAL_UNAVAILABLE");
    const cached = this.cache.get(input.channelId);
    if (cached && cached.expiresAtMs > this.clock() + 60_000)
      return cached.accessToken;

    const response = await this.request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: this.clientKey,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
      redirect: "error",
      signal: input.signal,
    });
    if (!response.ok)
      throw new Error(`TIKTOK_TOKEN_REFRESH_FAILED_${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("TIKTOK_TOKEN_RESPONSE_INVALID");
    const value = payload as Record<string, unknown>;
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      value.access_token.length > 4096 ||
      /[\r\n]/.test(value.access_token) ||
      value.open_id !== credential.externalChannelRef ||
      typeof value.scope !== "string" ||
      !value.scope
        .split(",")
        .map((scope) => scope.trim())
        .includes("video.publish") ||
      typeof value.expires_in !== "number" ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 120 ||
      value.expires_in > 172_800
    )
      throw new Error("TIKTOK_TOKEN_RESPONSE_INVALID");
    const token = {
      accessToken: value.access_token,
      expiresAtMs: this.clock() + value.expires_in * 1000,
    };
    this.cache.set(input.channelId, token);
    return token.accessToken;
  }
}

function secret(value: string, code: string): void {
  if (!value || value.length > 4096 || /[\r\n]/.test(value))
    throw new Error(code);
}
function uuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
function openId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value);
}
