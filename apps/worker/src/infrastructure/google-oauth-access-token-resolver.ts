import type { PublicationAccessTokenResolver } from "../application/publication-credential.port.js";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const YOUTUBE_MINE_ENDPOINT =
  "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true";

export interface YoutubeChannelCredential {
  channelId?: string;
  externalChannelRef: string;
  refreshToken: string;
}

type CachedToken = { accessToken: string; expiresAtMs: number };

export class GoogleOAuthAccessTokenResolver implements PublicationAccessTokenResolver {
  private readonly credentials = new Map<string, YoutubeChannelCredential>();
  private readonly cache = new Map<string, CachedToken>();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    credentials: readonly YoutubeChannelCredential[],
    private readonly request: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    requireSecret(clientId, "YOUTUBE_OAUTH_CLIENT_ID_INVALID");
    requireSecret(clientSecret, "YOUTUBE_OAUTH_CLIENT_SECRET_INVALID");
    for (const credential of credentials) {
      requireSecret(credential.refreshToken, "YOUTUBE_REFRESH_TOKEN_INVALID");
      if (
        (credential.channelId !== undefined &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            credential.channelId,
          )) ||
        !/^UC[A-Za-z0-9_-]{20,40}$/.test(credential.externalChannelRef) ||
        this.credentials.has(credential.externalChannelRef)
      )
        throw new Error("YOUTUBE_CHANNEL_CREDENTIAL_INVALID");
      this.credentials.set(credential.externalChannelRef, { ...credential });
    }
  }

  async resolve(input: {
    channelId: string;
    platform: "LOCAL_DRY_RUN" | "YOUTUBE" | "TIKTOK";
    externalChannelRef: string;
    signal?: AbortSignal;
  }): Promise<string> {
    if (input.platform !== "YOUTUBE")
      throw new Error("YOUTUBE_CREDENTIAL_PLATFORM_MISMATCH");
    const credential = this.credentials.get(input.externalChannelRef);
    if (
      !credential ||
      (credential.channelId !== undefined &&
        credential.channelId !== input.channelId)
    )
      throw new Error("YOUTUBE_CHANNEL_CREDENTIAL_UNAVAILABLE");
    const cacheKey = `${input.channelId}:${credential.externalChannelRef}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > this.clock() + 60_000)
      return cached.accessToken;

    const token = await this.refresh(credential.refreshToken, input.signal);
    await this.verifyChannel(
      token.accessToken,
      credential.externalChannelRef,
      input.signal,
    );
    this.cache.set(cacheKey, token);
    return token.accessToken;
  }

  private async refresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<CachedToken> {
    const response = await this.request(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      redirect: "error",
      signal,
    });
    if (!response.ok)
      throw new Error(`YOUTUBE_TOKEN_REFRESH_FAILED_${response.status}`);
    const payload: unknown = await response.json();
    const record = objectRecord(payload, "YOUTUBE_TOKEN_RESPONSE_INVALID");
    const accessToken = record.access_token;
    const expiresIn = record.expires_in;
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      accessToken.length > 4096 ||
      typeof expiresIn !== "number" ||
      !Number.isSafeInteger(expiresIn) ||
      expiresIn < 120 ||
      expiresIn > 86_400
    )
      throw new Error("YOUTUBE_TOKEN_RESPONSE_INVALID");
    return {
      accessToken,
      expiresAtMs: this.clock() + expiresIn * 1000,
    };
  }

  private async verifyChannel(
    accessToken: string,
    expectedChannelId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.request(YOUTUBE_MINE_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal,
    });
    if (!response.ok)
      throw new Error(`YOUTUBE_CHANNEL_VERIFY_FAILED_${response.status}`);
    const payload = objectRecord(
      (await response.json()) as unknown,
      "YOUTUBE_CHANNEL_VERIFY_INVALID",
    );
    if (
      !Array.isArray(payload.items) ||
      payload.items.length !== 1 ||
      objectRecord(payload.items[0], "YOUTUBE_CHANNEL_VERIFY_INVALID").id !==
        expectedChannelId
    )
      throw new Error("YOUTUBE_CHANNEL_IDENTITY_MISMATCH");
  }
}

function requireSecret(value: string, code: string): void {
  if (!value || value.length > 4096 || /[\r\n]/.test(value))
    throw new Error(code);
}

function objectRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(code);
  return value as Record<string, unknown>;
}
