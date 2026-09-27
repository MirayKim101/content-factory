const YOUTUBE_UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const ALLOWED_SESSION_HOSTS = new Set([
  "www.googleapis.com",
  "upload.youtube.com",
]);

export type YoutubeUploadProgress =
  | { state: "INCOMPLETE"; nextOffset: bigint }
  | { state: "COMPLETE"; videoId: string };

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
      signal: input.signal,
    });
    if (!response.ok)
      throw new Error(`YOUTUBE_UPLOAD_INIT_FAILED_${response.status}`);
    const location = response.headers.get("location");
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
        signal: input.signal,
      },
    );
    return this.parseProgress(response);
  }

  private async parseProgress(
    response: Response,
  ): Promise<YoutubeUploadProgress> {
    if (response.status === 308) {
      const range = response.headers.get("range");
      if (!range) return { state: "INCOMPLETE", nextOffset: 0n };
      const match = /^bytes=0-(\d+)$/.exec(range.trim());
      if (!match?.[1]) throw new Error("YOUTUBE_UPLOAD_RANGE_INVALID");
      return { state: "INCOMPLETE", nextOffset: BigInt(match[1]) + 1n };
    }
    if (!response.ok)
      throw new Error(`YOUTUBE_UPLOAD_FAILED_${response.status}`);
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
