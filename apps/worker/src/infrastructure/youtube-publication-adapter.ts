import type { PublicationMediaSource } from "../application/publication-media.port.js";
import type { PublicationAccessTokenResolver } from "../application/publication-credential.port.js";
import type { PublicationSessionRepository } from "../application/publication-session.port.js";
import type {
  PublicationAdapterResult,
  PublicationClaim,
  PublicationMetricsClaim,
  PublicationMetricsSnapshot,
  PublicationProvider,
  PublicationReconciliationClaim,
  PublicationReconciliationResult,
} from "../application/publication.port.js";
import { PublicationPermanentError } from "../application/publication.port.js";
import { PublicationSessionCipher } from "./publication-session-cipher.js";
import { YoutubeResumableTransport } from "./youtube-resumable-transport.js";

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export class YoutubePublicationAdapter implements PublicationProvider {
  readonly platform = "YOUTUBE" as const;

  constructor(
    private readonly tokens: PublicationAccessTokenResolver,
    private readonly media: PublicationMediaSource,
    private readonly sessions: PublicationSessionRepository,
    private readonly cipher: PublicationSessionCipher,
    private readonly transport: Pick<
      YoutubeResumableTransport,
      "initiate" | "probe" | "uploadChunk" | "status" | "metrics"
    >,
    private readonly chunkBytes = DEFAULT_CHUNK_BYTES,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < 256 * 1024 ||
      chunkBytes > 16 * 1024 * 1024
    )
      throw new Error("YOUTUBE_UPLOAD_CHUNK_SIZE_INVALID");
  }

  async publish(
    claim: PublicationClaim,
    signal?: AbortSignal,
  ): Promise<PublicationAdapterResult> {
    signal?.throwIfAborted();
    if (claim.platform !== this.platform)
      throw new Error("YOUTUBE_PUBLICATION_PLATFORM_MISMATCH");
    if (claim.contentKind !== "VERTICAL_RESULT")
      throw new PublicationPermanentError(
        "YOUTUBE_CONTENT_KIND_INVALID",
        "YouTube publication requires an approved vertical render.",
      );
    if (claim.contentType !== "video/mp4")
      throw new PublicationPermanentError(
        "YOUTUBE_CONTENT_TYPE_INVALID",
        "YouTube publication requires an MP4 render.",
      );
    const identity = {
      objectKey: claim.contentObjectKey,
      storageVersion: claim.contentStorageVersion,
      sizeBytes: claim.contentSizeBytes,
      sha256: claim.contentSha256,
      contentType: claim.contentType,
    };
    await this.media.verifyIdentity(identity, signal);
    signal?.throwIfAborted();
    const accessToken = await this.tokens.resolve({
      channelId: claim.channelId,
      platform: claim.platform,
      externalChannelRef: claim.externalChannelRef,
      signal,
    });

    const stored = await this.sessions.load(claim.id, claim.platform);
    signal?.throwIfAborted();
    let sessionUrl: string;
    let offset: bigint;
    if (stored) {
      const payload = this.cipher.decrypt({
        ...stored,
      });
      if (
        payload.kind !== "youtube-resumable-v1" ||
        typeof payload.sessionUrl !== "string"
      )
        throw new Error("YOUTUBE_UPLOAD_SESSION_PAYLOAD_INVALID");
      sessionUrl = payload.sessionUrl;
      const progress = await this.transport.probe({
        sessionUrl,
        accessToken,
        totalBytes: identity.sizeBytes,
        signal,
      });
      signal?.throwIfAborted();
      if (progress.state === "COMPLETE")
        return this.result(progress.videoId, identity.sha256);
      offset = progress.nextOffset;
      if (offset !== stored.uploadOffset) {
        const advanced = await this.sessions.advanceOffset({
          publicationIntentId: claim.id,
          platform: claim.platform,
          expectedOffset: stored.uploadOffset,
          nextOffset: offset,
          now: this.clock(),
        });
        if (!advanced) throw new Error("YOUTUBE_UPLOAD_SESSION_CONFLICT");
      }
    } else {
      sessionUrl = await this.transport.initiate({
        accessToken,
        totalBytes: identity.sizeBytes,
        contentType: identity.contentType,
        metadata: youtubeMetadata(claim.metadataSnapshot),
        signal,
      });
      signal?.throwIfAborted();
      offset = 0n;
      const encrypted = this.cipher.encrypt({
        publicationIntentId: claim.id,
        platform: claim.platform,
        session: { kind: "youtube-resumable-v1", sessionUrl },
      });
      const saved = await this.sessions.save(
        {
          publicationIntentId: claim.id,
          platform: claim.platform,
          ...encrypted,
          uploadOffset: 0n,
          expiresAt: null,
        },
        this.clock(),
      );
      if (!saved) throw new Error("YOUTUBE_UPLOAD_SESSION_NOT_SAVED");
    }

    while (offset < identity.sizeBytes) {
      signal?.throwIfAborted();
      const length = Number(
        minBigInt(BigInt(this.chunkBytes), identity.sizeBytes - offset),
      );
      const chunk = await this.media.readRange({ identity, offset, length });
      signal?.throwIfAborted();
      const progress = await this.transport.uploadChunk({
        sessionUrl,
        accessToken,
        chunk,
        offset,
        totalBytes: identity.sizeBytes,
        contentType: identity.contentType,
        signal,
      });
      if (progress.state === "COMPLETE")
        return this.result(progress.videoId, identity.sha256);
      if (
        progress.nextOffset <= offset ||
        progress.nextOffset > identity.sizeBytes
      )
        throw new Error("YOUTUBE_UPLOAD_PROGRESS_INVALID");
      const advanced = await this.sessions.advanceOffset({
        publicationIntentId: claim.id,
        platform: claim.platform,
        expectedOffset: offset,
        nextOffset: progress.nextOffset,
        now: this.clock(),
      });
      if (!advanced) throw new Error("YOUTUBE_UPLOAD_SESSION_CONFLICT");
      offset = progress.nextOffset;
    }
    throw new Error("YOUTUBE_UPLOAD_RECEIPT_MISSING");
  }

  async reconcile(
    claim: PublicationReconciliationClaim,
    signal?: AbortSignal,
  ): Promise<PublicationReconciliationResult> {
    const accessToken = await this.tokens.resolve({
      channelId: claim.channelId,
      platform: claim.platform,
      externalChannelRef: claim.externalChannelRef,
      signal,
    });
    const remoteStatus = await this.transport.status({
      accessToken,
      videoId: claim.remotePublicationId,
      signal,
    });
    if (["uploaded", "processing"].includes(remoteStatus))
      return { state: "PENDING", remoteStatus };
    if (remoteStatus === "processed")
      return {
        state: "PUBLISHED",
        remoteStatus,
        adapterVersion: "youtube-resumable-v1",
        providerReceipt: {
          videoId: claim.remotePublicationId,
          mediaSha256: claim.contentSha256,
        },
        publicUrl: `https://www.youtube.com/watch?v=${claim.remotePublicationId}`,
      };
    if (["failed", "rejected", "deleted"].includes(remoteStatus))
      return {
        state: "FAILED",
        remoteStatus,
        code: "YOUTUBE_PUBLICATION_FAILED",
        message: "YouTube rejected or removed the uploaded video.",
      };
    throw new Error("YOUTUBE_STATUS_UNKNOWN");
  }

  async metrics(
    claim: PublicationMetricsClaim,
    signal?: AbortSignal,
  ): Promise<PublicationMetricsSnapshot> {
    const accessToken = await this.tokens.resolve({
      channelId: claim.channelId,
      platform: claim.platform,
      externalChannelRef: claim.externalChannelRef,
      signal,
    });
    return {
      ...(await this.transport.metrics({
        accessToken,
        videoId: claim.remotePublicationId,
        signal,
      })),
      shareCount: null,
      adapterVersion: "youtube-data-v3-statistics",
    };
  }

  private result(videoId: string, sha256: string): PublicationAdapterResult {
    return {
      adapterVersion: "youtube-resumable-v1",
      providerReceipt: { videoId, mediaSha256: sha256 },
      publicUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }
}

function youtubeMetadata(snapshot: Record<string, unknown>) {
  const title = requiredText(snapshot.title, 100, "YOUTUBE_TITLE_INVALID");
  const description = optionalText(
    snapshot.description,
    5_000,
    "YOUTUBE_DESCRIPTION_INVALID",
  );
  const privacyStatus = snapshot.privacyStatus ?? "private";
  if (!["private", "unlisted", "public"].includes(String(privacyStatus)))
    throw permanentValidation("YOUTUBE_PRIVACY_STATUS_INVALID");
  const tags = snapshot.tags;
  if (tags !== undefined && !validTags(tags))
    throw permanentValidation("YOUTUBE_TAGS_INVALID");
  return {
    snippet: {
      title,
      ...(description ? { description } : {}),
      ...(Array.isArray(tags) ? { tags: tags.map((tag) => tag.trim()) } : {}),
    },
    status: { privacyStatus },
  };
}

function validTags(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (tag) => typeof tag === "string" && !!tag.trim() && tag.length <= 500,
    ) &&
    value.reduce((total, tag) => total + tag.length, 0) <= 500
  );
}

function requiredText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw permanentValidation(code);
  return value.trim();
}

function optionalText(
  value: unknown,
  maximum: number,
  code: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum)
    throw permanentValidation(code);
  return value.trim() || undefined;
}

function permanentValidation(code: string): PublicationPermanentError {
  return new PublicationPermanentError(code, code);
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
