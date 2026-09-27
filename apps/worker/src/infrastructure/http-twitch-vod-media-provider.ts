import type {
  TwitchVodMediaProvider,
  TwitchVodMediaResponse,
} from "../application/twitch-vod-media.port.js";

export class HttpTwitchVodMediaProvider implements TwitchVodMediaProvider {
  constructor(
    private readonly config: {
      baseUrl: string;
      bearerToken: string;
      timeoutMs: number;
    },
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async open(
    providerVideoId: string,
    offset: bigint,
    signal?: AbortSignal,
  ): Promise<TwitchVodMediaResponse> {
    if (!/^\d{1,64}$/.test(providerVideoId))
      throw new Error("TWITCH_VOD_MEDIA_ID_INVALID");
    if (offset < 0n) throw new Error("TWITCH_VOD_MEDIA_OFFSET_INVALID");
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const response = await this.fetchImplementation(
      `${this.config.baseUrl}/v1/twitch/vods/${providerVideoId}/media`,
      {
        headers: {
          authorization: `Bearer ${this.config.bearerToken}`,
          ...(offset > 0n ? { range: `bytes=${offset}-` } : {}),
        },
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    if (!response.ok)
      throw new Error(`TWITCH_VOD_MEDIA_HTTP_${response.status}`);
    if (!response.body || response.headers.get("content-type") !== "video/mp4")
      throw new Error("TWITCH_VOD_MEDIA_RESPONSE_INVALID");
    const identity = parseIdentity(response, offset);
    return {
      body: response.body,
      contentType: "video/mp4",
      totalSizeBytes: identity.totalSizeBytes,
      offset,
    };
  }
}

function parseIdentity(
  response: Response,
  offset: bigint,
): { totalSizeBytes: bigint } {
  if (offset === 0n) {
    if (response.status !== 200)
      throw new Error("TWITCH_VOD_MEDIA_RANGE_MISMATCH");
    const length = positiveBigInt(response.headers.get("content-length"));
    return { totalSizeBytes: length };
  }
  if (response.status !== 206)
    throw new Error("TWITCH_VOD_MEDIA_RANGE_UNSUPPORTED");
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("content-range") ?? "",
  );
  if (!range) throw new Error("TWITCH_VOD_MEDIA_RANGE_MISMATCH");
  const start = BigInt(range[1]!);
  const end = BigInt(range[2]!);
  const totalSizeBytes = BigInt(range[3]!);
  const contentLength = positiveBigInt(response.headers.get("content-length"));
  if (
    start !== offset ||
    end < start ||
    totalSizeBytes <= end ||
    contentLength !== end - start + 1n
  )
    throw new Error("TWITCH_VOD_MEDIA_RANGE_MISMATCH");
  return { totalSizeBytes };
}

function positiveBigInt(value: string | null): bigint {
  if (!value || !/^\d+$/.test(value))
    throw new Error("TWITCH_VOD_MEDIA_LENGTH_INVALID");
  const parsed = BigInt(value);
  if (parsed < 1n) throw new Error("TWITCH_VOD_MEDIA_LENGTH_INVALID");
  return parsed;
}
