import type {
  TwitchVideoProvider,
  TwitchVodMetadata,
  TwitchVodPage,
} from "../application/twitch-reconciliation.port.js";

export interface TwitchAccessTokenProvider {
  resolve(signal?: AbortSignal): Promise<string>;
  invalidate?(): void;
}

export class TwitchHelixClient implements TwitchVideoProvider {
  constructor(
    private readonly clientId: string,
    private readonly accessToken: TwitchAccessTokenProvider,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async listArchives(
    broadcasterId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<TwitchVodPage> {
    const params = new URLSearchParams({
      user_id: broadcasterId,
      type: "archive",
      first: "100",
    });
    if (cursor) params.set("after", cursor);
    let response = await this.requestArchives(
      params,
      await this.accessToken.resolve(signal),
      signal,
    );
    if (response.status === 401 && this.accessToken.invalidate) {
      await discardResponseBody(response);
      this.accessToken.invalidate();
      response = await this.requestArchives(
        params,
        await this.accessToken.resolve(signal),
        signal,
      );
    }
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`TWITCH_HELIX_${response.status}`);
    }
    const payload: unknown = await response.json();
    return parseTwitchVodPage(payload);
  }

  private requestArchives(
    params: URLSearchParams,
    accessToken: string,
    signal?: AbortSignal,
  ) {
    return this.fetchImplementation(
      `https://api.twitch.tv/helix/videos?${params}`,
      {
        headers: {
          "Client-Id": this.clientId,
          Authorization: `Bearer ${accessToken}`,
        },
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function parseTwitchVodPage(value: unknown): TwitchVodPage {
  if (!value || typeof value !== "object")
    throw new Error("TWITCH_VOD_RESPONSE_INVALID");
  const input = value as {
    data?: unknown;
    pagination?: { cursor?: unknown };
  };
  if (!Array.isArray(input.data))
    throw new Error("TWITCH_VOD_RESPONSE_INVALID");
  const items = input.data.map(parseVideo);
  const cursor = input.pagination?.cursor;
  if (cursor !== undefined && typeof cursor !== "string")
    throw new Error("TWITCH_VOD_RESPONSE_INVALID");
  return { items, nextCursor: cursor?.trim() || null };
}

function parseVideo(value: unknown): TwitchVodMetadata {
  if (!value || typeof value !== "object")
    throw new Error("TWITCH_VOD_RESPONSE_INVALID");
  const row = value as Record<string, unknown>;
  const startedAt = new Date(String(row.created_at ?? ""));
  const publishedAt = new Date(String(row.published_at ?? ""));
  const durationSeconds = parseDuration(String(row.duration ?? ""));
  if (
    typeof row.id !== "string" ||
    typeof row.title !== "string" ||
    row.type !== "archive" ||
    Number.isNaN(startedAt.getTime()) ||
    Number.isNaN(publishedAt.getTime()) ||
    durationSeconds <= 0
  )
    throw new Error("TWITCH_VOD_RESPONSE_INVALID");
  return {
    providerVideoId: row.id,
    streamId:
      typeof row.stream_id === "string" && row.stream_id ? row.stream_id : null,
    title: row.title.slice(0, 500),
    vodType: "archive",
    durationSeconds,
    startedAt,
    publishedAt,
  };
}

export function parseTwitchDuration(value: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || !match[0]) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  if (minutes > 59 || seconds > 59) return 0;
  return hours * 3600 + minutes * 60 + seconds;
}

const parseDuration = parseTwitchDuration;
