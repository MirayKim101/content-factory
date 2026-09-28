const YOUTUBE_UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const ALLOWED_SESSION_HOSTS = new Set([
  "www.googleapis.com",
  "upload.youtube.com",
]);
const YOUTUBE_VIDEO_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

export type YoutubeUploadProgress =
  | { state: "INCOMPLETE"; nextOffset: bigint }
  | { state: "COMPLETE"; videoId: string };

export interface YoutubeVideoMetrics {
  viewCount: bigint;
  likeCount: bigint | null;
  commentCount: bigint | null;
}

export class YoutubeResumableTransport {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly endpoint = YOUTUBE_UPLOAD_ENDPOINT,
  ) {}

  async initiate(input: {
    accessToken: string;
    totalBytes: bigint;
    contentType: string;
    metadata: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<string> {
    this.requireToken(input.accessToken);
    if (input.totalBytes <= 0n) throw new Error("YOUTUBE_MEDIA_SIZE_INVALID");
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": input.totalBytes.toString(),
        "x-upload-content-type": input.contentType,
      },
      body: JSON.stringify(input.metadata),
      redirect: "error",
      signal: input.signal,
    });
    if (!response.ok) {
      await discard(response);
      throw new Error(`YOUTUBE_UPLOAD_INIT_FAILED_${response.status}`);
    }
    const location = response.headers.get("location");
    await discard(response);
    if (!location) throw new Error("YOUTUBE_UPLOAD_SESSION_MISSING");
    return this.requireSessionUrl(location);
  }

  async probe(input: {
    sessionUrl: string;
    accessToken: string;
    totalBytes: bigint;
    signal?: AbortSignal;
  }): Promise<YoutubeUploadProgress> {
    this.requireToken(input.accessToken);
    const response = await this.request(
      this.requireSessionUrl(input.sessionUrl),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-length": "0",
          "content-range": `bytes */${input.totalBytes}`,
        },
        redirect: "error",
        signal: input.signal,
      },
    );
    return this.parseProgress(response);
  }

  async uploadChunk(input: {
    sessionUrl: string;
    accessToken: string;
    chunk: Uint8Array;
    offset: bigint;
    totalBytes: bigint;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<YoutubeUploadProgress> {
    this.requireToken(input.accessToken);
    if (!input.chunk.byteLength) throw new Error("YOUTUBE_UPLOAD_CHUNK_EMPTY");
    const end = input.offset + BigInt(input.chunk.byteLength) - 1n;
    if (input.offset < 0n || end >= input.totalBytes)
      throw new Error("YOUTUBE_UPLOAD_RANGE_INVALID");
    const response = await this.request(
      this.requireSessionUrl(input.sessionUrl),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-length": input.chunk.byteLength.toString(),
          "content-range": `bytes ${input.offset}-${end}/${input.totalBytes}`,
          "content-type": input.contentType,
        },
        body: Uint8Array.from(input.chunk).buffer,
        redirect: "error",
        signal: input.signal,
      },
    );
    return this.parseProgress(response);
  }

  async status(input: {
    accessToken: string;
    videoId: string;
    signal?: AbortSignal;
  }): Promise<string> {
    this.requireToken(input.accessToken);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(input.videoId))
      throw new Error("YOUTUBE_VIDEO_ID_INVALID");
    const url = new URL(YOUTUBE_VIDEO_ENDPOINT);
    url.searchParams.set("part", "status");
    url.searchParams.set("id", input.videoId);
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      redirect: "error",
      signal: input.signal,
    });
    if (!response.ok) {
      await discard(response);
      throw new Error(`YOUTUBE_STATUS_FAILED_${response.status}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("YOUTUBE_STATUS_RESPONSE_INVALID");
    const items = (payload as Record<string, unknown>).items;
    if (!Array.isArray(items) || items.length !== 1)
      throw new Error("YOUTUBE_STATUS_RESPONSE_INVALID");
    const item = items[0];
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("YOUTUBE_STATUS_RESPONSE_INVALID");
    const status = (item as Record<string, unknown>).status;
    if (!status || typeof status !== "object" || Array.isArray(status))
      throw new Error("YOUTUBE_STATUS_RESPONSE_INVALID");
    const uploadStatus = (status as Record<string, unknown>).uploadStatus;
    if (typeof uploadStatus !== "string" || uploadStatus.length > 64)
      throw new Error("YOUTUBE_STATUS_RESPONSE_INVALID");
    return uploadStatus;
  }

  async metrics(input: {
    accessToken: string;
    videoId: string;
    signal?: AbortSignal;
  }): Promise<YoutubeVideoMetrics> {
    this.requireToken(input.accessToken);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(input.videoId))
      throw new Error("YOUTUBE_VIDEO_ID_INVALID");
    const url = new URL(YOUTUBE_VIDEO_ENDPOINT);
    url.searchParams.set("part", "statistics");
    url.searchParams.set("id", input.videoId);
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      redirect: "error",
      signal: input.signal,
    });
    if (!response.ok) {
      await discard(response);
      throw new Error(`YOUTUBE_METRICS_FAILED_${response.status}`);
    }
    const payload: unknown = await response.json();
    const item = objectArrayItem(payload, "items");
    const statistics = objectValue(item, "statistics");
    return {
      viewCount: unsignedBigInt(statistics.viewCount, true),
      likeCount: unsignedBigInt(statistics.likeCount, false),
      commentCount: unsignedBigInt(statistics.commentCount, false),
    };
  }

  private async parseProgress(
    response: Response,
  ): Promise<YoutubeUploadProgress> {
    if (response.status === 308) {
      const range = response.headers.get("range");
      await discard(response);
      if (!range) return { state: "INCOMPLETE", nextOffset: 0n };
      const match = /^bytes=0-(\d+)$/.exec(range.trim());
      if (!match?.[1]) throw new Error("YOUTUBE_UPLOAD_RANGE_INVALID");
      return { state: "INCOMPLETE", nextOffset: BigInt(match[1]) + 1n };
    }
    if (!response.ok) {
      await discard(response);
      throw new Error(`YOUTUBE_UPLOAD_FAILED_${response.status}`);
    }
    const payload: unknown = await response.json();
    const videoId =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).id
        : undefined;
    if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(videoId))
      throw new Error("YOUTUBE_UPLOAD_RECEIPT_INVALID");
    return { state: "COMPLETE", videoId };
  }

  private requireToken(value: string): void {
    if (!value || value.length > 4096 || /[\r\n]/.test(value))
      throw new Error("YOUTUBE_ACCESS_TOKEN_INVALID");
  }

  private requireSessionUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("YOUTUBE_UPLOAD_SESSION_INVALID");
    }
    if (
      parsed.protocol !== "https:" ||
      !ALLOWED_SESSION_HOSTS.has(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw new Error("YOUTUBE_UPLOAD_SESSION_INVALID");
    return parsed.toString();
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function objectArrayItem(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("YOUTUBE_METRICS_RESPONSE_INVALID");
  const items = (value as Record<string, unknown>)[key];
  if (!Array.isArray(items) || items.length !== 1)
    throw new Error("YOUTUBE_METRICS_RESPONSE_INVALID");
  return objectValue({ item: items[0] }, "item");
}

function objectValue(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const nested = value[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested))
    throw new Error("YOUTUBE_METRICS_RESPONSE_INVALID");
  return nested as Record<string, unknown>;
}

function unsignedBigInt(value: unknown, required: true): bigint;
function unsignedBigInt(value: unknown, required: false): bigint | null;
function unsignedBigInt(value: unknown, required: boolean): bigint | null {
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value))
    throw new Error("YOUTUBE_METRICS_RESPONSE_INVALID");
  return BigInt(value);
}
