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
    expectedRepresentationEtag: string | null,
    signal?: AbortSignal,
  ): Promise<TwitchVodMediaResponse> {
    if (!/^\d{1,64}$/.test(providerVideoId))
      throw new Error("TWITCH_VOD_MEDIA_ID_INVALID");
    if (offset < 0n) throw new Error("TWITCH_VOD_MEDIA_OFFSET_INVALID");
    const controller = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const timeout = setTimeout(
      () => controller.abort(new Error("TWITCH_VOD_MEDIA_HEADER_TIMEOUT")),
      this.config.timeoutMs,
    );
    try {
      const response = await this.fetchImplementation(
        `${this.config.baseUrl}/v1/twitch/vods/${providerVideoId}/media`,
        {
          headers: {
            authorization: `Bearer ${this.config.bearerToken}`,
            ...(offset > 0n
              ? {
                  range: `bytes=${offset}-`,
                  "if-range": requireStrongEtag(expectedRepresentationEtag),
                }
              : {}),
          },
          redirect: "error",
          signal: requestSignal,
        },
      );
      try {
        if (!response.ok)
          throw new Error(`TWITCH_VOD_MEDIA_HTTP_${response.status}`);
        if (
          !response.body ||
          response.headers.get("content-type") !== "video/mp4"
        )
          throw new Error("TWITCH_VOD_MEDIA_RESPONSE_INVALID");
        const identity = parseIdentity(
          response,
          offset,
          expectedRepresentationEtag,
        );
        return {
          body: response.body,
          contentType: "video/mp4",
          totalSizeBytes: identity.totalSizeBytes,
          offset,
          representationEtag: identity.representationEtag,
        };
      } catch (error) {
        await response.body?.cancel(error).catch(() => undefined);
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseIdentity(
  response: Response,
  offset: bigint,
  expectedRepresentationEtag: string | null,
): { totalSizeBytes: bigint; representationEtag: string } {
  if (offset === 0n) {
    if (response.status !== 200)
      throw new Error("TWITCH_VOD_MEDIA_RANGE_MISMATCH");
    const representationEtag = requireStrongEtag(response.headers.get("etag"));
    const length = positiveBigInt(response.headers.get("content-length"));
    return { totalSizeBytes: length, representationEtag };
  }
  if (response.status !== 206)
    throw new Error("TWITCH_VOD_MEDIA_REPRESENTATION_CHANGED");
  let representationEtag: string;
  try {
    representationEtag = requireStrongEtag(response.headers.get("etag"));
  } catch {
    throw new Error("TWITCH_VOD_MEDIA_REPRESENTATION_CHANGED");
  }
  if (representationEtag !== expectedRepresentationEtag)
    throw new Error("TWITCH_VOD_MEDIA_REPRESENTATION_CHANGED");
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
  return { totalSizeBytes, representationEtag };
}

function requireStrongEtag(value: string | null): string {
  if (
    !value ||
    value.length > 200 ||
    value.startsWith("W/") ||
    !/^"[\x21\x23-\x7e]+"$/.test(value)
  )
    throw new Error("TWITCH_VOD_MEDIA_ETAG_INVALID");
  return value;
}

function positiveBigInt(value: string | null): bigint {
  if (!value || !/^\d+$/.test(value))
    throw new Error("TWITCH_VOD_MEDIA_LENGTH_INVALID");
  const parsed = BigInt(value);
  if (parsed < 1n) throw new Error("TWITCH_VOD_MEDIA_LENGTH_INVALID");
  return parsed;
}
