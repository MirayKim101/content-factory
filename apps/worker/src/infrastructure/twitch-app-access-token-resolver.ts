const TOKEN_ENDPOINT = "https://id.twitch.tv/oauth2/token";
const REFRESH_SKEW_MS = 60_000;

export class TwitchAppAccessTokenResolver {
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly request: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  resolve(): Promise<string> {
    const now = this.clock();
    if (this.cached && this.cached.expiresAt - REFRESH_SKEW_MS > now)
      return Promise.resolve(this.cached.token);
    if (this.pending) return this.pending;
    this.pending = this.acquire(now).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async acquire(now: number): Promise<string> {
    const response = await this.request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`TWITCH_OAUTH_${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("TWITCH_OAUTH_RESPONSE_INVALID");
    const value = payload as Record<string, unknown>;
    if (
      typeof value.access_token !== "string" ||
      !/^[A-Za-z0-9._-]{1,4096}$/.test(value.access_token) ||
      typeof value.expires_in !== "number" ||
      !Number.isSafeInteger(value.expires_in) ||
      value.expires_in < 120 ||
      value.expires_in > 10_000_000 ||
      value.token_type !== "bearer"
    )
      throw new Error("TWITCH_OAUTH_RESPONSE_INVALID");
    this.cached = {
      token: value.access_token,
      expiresAt: now + value.expires_in * 1000,
    };
    return value.access_token;
  }
}
