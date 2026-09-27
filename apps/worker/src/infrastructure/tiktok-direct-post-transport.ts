const API_ORIGIN = "https://open.tiktokapis.com";
const CREATOR_INFO_ENDPOINT = `${API_ORIGIN}/v2/post/publish/creator_info/query/`;
const DIRECT_POST_ENDPOINT = `${API_ORIGIN}/v2/post/publish/video/init/`;
const STATUS_ENDPOINT = `${API_ORIGIN}/v2/post/publish/status/fetch/`;
const VIDEO_QUERY_ENDPOINT = `${API_ORIGIN}/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count`;
const UPLOAD_HOST_SUFFIX = ".tiktokapis.com";

export type TikTokPostStatus =
  | "PROCESSING_UPLOAD"
  | "PROCESSING_DOWNLOAD"
  | "SEND_TO_USER_INBOX"
  | "PUBLISH_COMPLETE"
  | "FAILED";

export interface TikTokCreatorInfo {
  creatorAvatarUrl: string;
  creatorNickname: string;
  creatorUsername: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

export interface TikTokUploadPlan {
  chunkSize: number;
  totalChunkCount: number;
}

export class TikTokDirectPostTransport {
  constructor(private readonly request: typeof fetch = fetch) {}

  planUpload(totalBytes: bigint): TikTokUploadPlan {
    if (totalBytes <= 0n || totalBytes > 4n * 1024n ** 3n)
      throw new Error("TIKTOK_MEDIA_SIZE_INVALID");
    const min = 5n * 1024n ** 2n;
    const max = 64n * 1024n ** 2n;
    if (totalBytes < min)
      return { chunkSize: Number(totalBytes), totalChunkCount: 1 };
    const chunkSize =
      totalBytes <= max
        ? totalBytes
        : totalBytes < max * 2n
          ? totalBytes / 2n
          : max;
    const count = totalBytes / chunkSize;
    if (count < 1n || count > 1000n)
      throw new Error("TIKTOK_MEDIA_CHUNK_COUNT_INVALID");
    return { chunkSize: Number(chunkSize), totalChunkCount: Number(count) };
  }

  async creatorInfo(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<TikTokCreatorInfo> {
    const data = await this.post(
      CREATOR_INFO_ENDPOINT,
      accessToken,
      {},
      signal,
    );
    return {
      creatorAvatarUrl: this.string(data.creator_avatar_url, 2048),
      creatorNickname: this.string(data.creator_nickname, 256),
      creatorUsername: this.string(data.creator_username, 256),
      privacyLevelOptions: this.stringArray(data.privacy_level_options, 16, 64),
      commentDisabled: this.boolean(data.comment_disabled),
      duetDisabled: this.boolean(data.duet_disabled),
      stitchDisabled: this.boolean(data.stitch_disabled),
      maxVideoPostDurationSec: this.integer(
        data.max_video_post_duration_sec,
        1,
        3600,
      ),
    };
  }

  async initiate(input: {
    accessToken: string;
    totalBytes: bigint;
    title: string;
    privacyLevel: string;
    disableComment: boolean;
    disableDuet: boolean;
    disableStitch: boolean;
    brandContentToggle: boolean;
    brandOrganicToggle: boolean;
    isAigc?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    publishId: string;
    uploadUrl: string;
    plan: TikTokUploadPlan;
  }> {
    if (!input.title || input.title.length > 2200)
      throw new Error("TIKTOK_TITLE_INVALID");
    if (!/^[A-Z_]{2,64}$/.test(input.privacyLevel))
      throw new Error("TIKTOK_PRIVACY_LEVEL_INVALID");
    const plan = this.planUpload(input.totalBytes);
    const data = await this.post(
      DIRECT_POST_ENDPOINT,
      input.accessToken,
      {
        post_info: {
          title: input.title,
          privacy_level: input.privacyLevel,
          disable_comment: input.disableComment,
          disable_duet: input.disableDuet,
          disable_stitch: input.disableStitch,
          brand_content_toggle: input.brandContentToggle,
          brand_organic_toggle: input.brandOrganicToggle,
          ...(input.isAigc === undefined ? {} : { is_aigc: input.isAigc }),
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: Number(input.totalBytes),
          chunk_size: plan.chunkSize,
          total_chunk_count: plan.totalChunkCount,
        },
      },
      input.signal,
    );
    return {
      publishId: this.identifier(data.publish_id),
      uploadUrl: this.uploadUrl(data.upload_url),
      plan,
    };
  }

  async uploadChunk(input: {
    uploadUrl: string;
    chunk: Uint8Array;
    offset: bigint;
    totalBytes: bigint;
    contentType: "video/mp4" | "video/quicktime" | "video/webm";
    final: boolean;
    signal?: AbortSignal;
  }): Promise<{ complete: boolean; nextOffset: bigint }> {
    if (!input.chunk.byteLength) throw new Error("TIKTOK_UPLOAD_CHUNK_EMPTY");
    const chunkBytes = BigInt(input.chunk.byteLength);
    const minChunkBytes = 5n * 1024n ** 2n;
    const maxChunkBytes = 64n * 1024n ** 2n;
    const maxFinalChunkBytes = 128n * 1024n ** 2n;
    const end = input.offset + chunkBytes - 1n;
    if (input.offset < 0n || end >= input.totalBytes)
      throw new Error("TIKTOK_UPLOAD_RANGE_INVALID");
    const wholeSingleFile =
      input.offset === 0n &&
      chunkBytes === input.totalBytes &&
      input.totalBytes <= maxChunkBytes;
    if (
      (!input.final &&
        (chunkBytes < minChunkBytes || chunkBytes > maxChunkBytes)) ||
      (input.final &&
        !wholeSingleFile &&
        (chunkBytes < minChunkBytes || chunkBytes > maxFinalChunkBytes)) ||
      (input.final &&
        input.offset === 0n &&
        input.totalBytes > maxChunkBytes) ||
      (input.final && end !== input.totalBytes - 1n) ||
      (!input.final && end === input.totalBytes - 1n)
    )
      throw new Error("TIKTOK_UPLOAD_CHUNK_SIZE_INVALID");
    const response = await this.request(this.uploadUrl(input.uploadUrl), {
      method: "PUT",
      headers: {
        "content-type": input.contentType,
        "content-length": String(input.chunk.byteLength),
        "content-range": `bytes ${input.offset}-${end}/${input.totalBytes}`,
      },
      body: Uint8Array.from(input.chunk).buffer,
      signal: input.signal,
    });
    const expected = input.final ? 201 : 206;
    if (response.status !== expected)
      throw new Error(`TIKTOK_UPLOAD_FAILED_${response.status}`);
    return { complete: input.final, nextOffset: end + 1n };
  }

  async status(input: {
    accessToken: string;
    publishId: string;
    signal?: AbortSignal;
  }): Promise<{
    status: TikTokPostStatus;
    failReason?: string;
    postIds: string[];
    uploadedBytes?: bigint;
  }> {
    const data = await this.post(
      STATUS_ENDPOINT,
      input.accessToken,
      { publish_id: this.identifier(input.publishId) },
      input.signal,
    );
    const status = this.string(data.status, 64);
    const statuses: TikTokPostStatus[] = [
      "PROCESSING_UPLOAD",
      "PROCESSING_DOWNLOAD",
      "SEND_TO_USER_INBOX",
      "PUBLISH_COMPLETE",
      "FAILED",
    ];
    if (!statuses.includes(status as TikTokPostStatus))
      throw new Error("TIKTOK_STATUS_RESPONSE_INVALID");
    const rawIds = data.publicaly_available_post_id;
    const postIds = Array.isArray(rawIds)
      ? rawIds.map((value) => {
          if (
            (typeof value !== "string" && typeof value !== "number") ||
            !/^\d{1,32}$/.test(String(value))
          )
            throw new Error("TIKTOK_STATUS_RESPONSE_INVALID");
          return String(value);
        })
      : [];
    const failReason =
      data.fail_reason === undefined
        ? undefined
        : this.string(data.fail_reason, 128);
    const uploadedBytes =
      data.uploaded_bytes === undefined
        ? undefined
        : BigInt(this.integer(data.uploaded_bytes, 0, Number.MAX_SAFE_INTEGER));
    return {
      status: status as TikTokPostStatus,
      failReason,
      postIds,
      uploadedBytes,
    };
  }

  async metrics(input: {
    accessToken: string;
    videoId: string;
    signal?: AbortSignal;
  }): Promise<{
    viewCount: bigint;
    likeCount: bigint;
    commentCount: bigint;
    shareCount: bigint;
  }> {
    const videoId = this.identifier(input.videoId);
    const data = await this.post(
      VIDEO_QUERY_ENDPOINT,
      input.accessToken,
      { filters: { video_ids: [videoId] } },
      input.signal,
    );
    if (!Array.isArray(data.videos) || data.videos.length !== 1)
      throw new Error("TIKTOK_METRICS_RESPONSE_INVALID");
    const video = data.videos[0];
    if (!video || typeof video !== "object" || Array.isArray(video))
      throw new Error("TIKTOK_METRICS_RESPONSE_INVALID");
    const record = video as Record<string, unknown>;
    if (String(record.id) !== videoId)
      throw new Error("TIKTOK_METRICS_RESPONSE_INVALID");
    return {
      viewCount: this.unsignedBigInt(record.view_count),
      likeCount: this.unsignedBigInt(record.like_count),
      commentCount: this.unsignedBigInt(record.comment_count),
      shareCount: this.unsignedBigInt(record.share_count),
    };
  }

  private async post(
    url: string,
    token: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.token(token);
    const response = await this.request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`TIKTOK_API_FAILED_${response.status}`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("TIKTOK_API_RESPONSE_INVALID");
    const root = payload as Record<string, unknown>;
    const error = root.error;
    if (
      !error ||
      typeof error !== "object" ||
      Array.isArray(error) ||
      (error as Record<string, unknown>).code !== "ok"
    )
      throw new Error("TIKTOK_API_RESPONSE_INVALID");
    const data = root.data;
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("TIKTOK_API_RESPONSE_INVALID");
    return data as Record<string, unknown>;
  }

  private token(value: string): void {
    if (!value || value.length > 4096 || /[\r\n]/.test(value))
      throw new Error("TIKTOK_ACCESS_TOKEN_INVALID");
  }
  private identifier(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(value))
      throw new Error("TIKTOK_IDENTIFIER_INVALID");
    return value;
  }
  private uploadUrl(value: unknown): string {
    if (typeof value !== "string" || value.length > 2048)
      throw new Error("TIKTOK_UPLOAD_URL_INVALID");
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("TIKTOK_UPLOAD_URL_INVALID");
    }
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname.endsWith(UPLOAD_HOST_SUFFIX) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw new Error("TIKTOK_UPLOAD_URL_INVALID");
    return parsed.toString();
  }
  private string(value: unknown, max: number): string {
    if (typeof value !== "string" || !value || value.length > max)
      throw new Error("TIKTOK_API_RESPONSE_INVALID");
    return value;
  }
  private stringArray(
    value: unknown,
    maxItems: number,
    maxLength: number,
  ): string[] {
    if (!Array.isArray(value) || !value.length || value.length > maxItems)
      throw new Error("TIKTOK_API_RESPONSE_INVALID");
    return value.map((item) => this.string(item, maxLength));
  }
  private boolean(value: unknown): boolean {
    if (typeof value !== "boolean")
      throw new Error("TIKTOK_API_RESPONSE_INVALID");
    return value;
  }
  private integer(value: unknown, min: number, max: number): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    )
      throw new Error("TIKTOK_API_RESPONSE_INVALID");
    return value;
  }
  private unsignedBigInt(value: unknown): bigint {
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      !/^\d{1,20}$/.test(String(value))
    )
      throw new Error("TIKTOK_METRICS_RESPONSE_INVALID");
    return BigInt(value);
  }
}
