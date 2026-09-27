import type { PublicationAccessTokenResolver } from "../application/publication-credential.port.js";
import type { PublicationMediaSource } from "../application/publication-media.port.js";
import type { PublicationSessionRepository } from "../application/publication-session.port.js";
import {
  PublicationOutcomeUnknownError,
  type PublicationAdapterResult,
  type PublicationClaim,
  type PublicationProvider,
  type PublicationReconciliationClaim,
  type PublicationReconciliationResult,
} from "../application/publication.port.js";
import { PublicationSessionCipher } from "./publication-session-cipher.js";
import {
  TikTokDirectPostTransport,
  type TikTokCreatorInfo,
} from "./tiktok-direct-post-transport.js";

export class TikTokPublicationAdapter implements PublicationProvider {
  readonly platform = "TIKTOK" as const;

  constructor(
    private readonly tokens: PublicationAccessTokenResolver,
    private readonly media: PublicationMediaSource,
    private readonly sessions: PublicationSessionRepository,
    private readonly cipher: PublicationSessionCipher,
    private readonly transport: Pick<
      TikTokDirectPostTransport,
      "creatorInfo" | "initiate" | "uploadChunk" | "status"
    >,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async publish(claim: PublicationClaim): Promise<PublicationAdapterResult> {
    if (claim.platform !== this.platform)
      throw new Error("TIKTOK_PUBLICATION_PLATFORM_MISMATCH");
    const identity = {
      objectKey: claim.contentObjectKey,
      sizeBytes: claim.contentSizeBytes,
      sha256: claim.contentSha256,
      contentType: claim.contentType,
    };
    if (
      !(["video/mp4", "video/quicktime", "video/webm"] as unknown[]).includes(
        identity.contentType,
      )
    )
      throw new Error("TIKTOK_CONTENT_TYPE_INVALID");
    await this.media.verifyIdentity(identity);
    const accessToken = await this.tokens.resolve({
      channelId: claim.channelId,
      platform: claim.platform,
      externalChannelRef: claim.externalChannelRef,
    });
    const creator = await this.transport.creatorInfo(accessToken);
    const metadata = requireTikTokMetadata(claim.metadataSnapshot, creator);

    const stored = await this.sessions.load(claim.id, claim.platform);
    let publishId: string;
    let uploadUrl: string;
    let chunkSize: number;
    let offset: bigint;
    if (stored) {
      const payload = this.cipher.decrypt(stored);
      if (
        payload.kind !== "tiktok-direct-post-v1" ||
        typeof payload.publishId !== "string" ||
        typeof payload.uploadUrl !== "string" ||
        typeof payload.chunkSize !== "number" ||
        !Number.isSafeInteger(payload.chunkSize) ||
        payload.chunkSize <= 0
      )
        throw new Error("TIKTOK_UPLOAD_SESSION_PAYLOAD_INVALID");
      publishId = payload.publishId;
      uploadUrl = payload.uploadUrl;
      chunkSize = payload.chunkSize;
      const remote = await this.transport.status({ accessToken, publishId });
      if (remote.status === "PUBLISH_COMPLETE")
        return this.result(publishId, identity.sha256, remote.postIds);
      if (remote.status === "FAILED")
        throw new Error(
          `TIKTOK_PUBLICATION_FAILED_${safeCode(remote.failReason)}`,
        );
      offset = remote.uploadedBytes ?? stored.uploadOffset;
      if (offset < stored.uploadOffset || offset > identity.sizeBytes)
        throw new Error("TIKTOK_UPLOAD_PROGRESS_INVALID");
      if (offset !== stored.uploadOffset) {
        const advanced = await this.sessions.advanceOffset({
          publicationIntentId: claim.id,
          platform: claim.platform,
          expectedOffset: stored.uploadOffset,
          nextOffset: offset,
          now: this.clock(),
        });
        if (!advanced) throw new Error("TIKTOK_UPLOAD_SESSION_CONFLICT");
      }
    } else {
      const initialized = await this.transport.initiate({
        accessToken,
        totalBytes: identity.sizeBytes,
        ...metadata,
      });
      publishId = initialized.publishId;
      uploadUrl = initialized.uploadUrl;
      chunkSize = initialized.plan.chunkSize;
      offset = 0n;
      const encrypted = this.cipher.encrypt({
        publicationIntentId: claim.id,
        platform: claim.platform,
        session: {
          kind: "tiktok-direct-post-v1",
          publishId,
          uploadUrl,
          chunkSize,
        },
      });
      const now = this.clock();
      const saved = await this.sessions.save(
        {
          publicationIntentId: claim.id,
          platform: claim.platform,
          ...encrypted,
          uploadOffset: 0n,
          // Keep publish_id durable until terminal reconciliation. Dropping it
          // with the expiring upload URL could cause a duplicate Direct Post
          // after an ambiguous provider response and worker restart.
          expiresAt: null,
        },
        now,
      );
      if (!saved) throw new Error("TIKTOK_UPLOAD_SESSION_NOT_SAVED");
    }

    while (offset < identity.sizeBytes) {
      const length = Number(
        minBigInt(BigInt(chunkSize), identity.sizeBytes - offset),
      );
      const final = offset + BigInt(length) === identity.sizeBytes;
      const chunk = await this.media.readRange({ identity, offset, length });
      const progress = await this.transport.uploadChunk({
        uploadUrl,
        chunk,
        offset,
        totalBytes: identity.sizeBytes,
        contentType: identity.contentType as
          "video/mp4" | "video/quicktime" | "video/webm",
        final,
      });
      if (
        progress.nextOffset <= offset ||
        progress.nextOffset > identity.sizeBytes
      )
        throw new Error("TIKTOK_UPLOAD_PROGRESS_INVALID");
      const advanced = await this.sessions.advanceOffset({
        publicationIntentId: claim.id,
        platform: claim.platform,
        expectedOffset: offset,
        nextOffset: progress.nextOffset,
        now: this.clock(),
      });
      if (!advanced) throw new Error("TIKTOK_UPLOAD_SESSION_CONFLICT");
      offset = progress.nextOffset;
    }
    throw new PublicationOutcomeUnknownError(
      "TIKTOK_PUBLICATION_PROCESSING",
      "TikTok accepted the upload and is processing the post.",
      publishId,
      "PROCESSING_UPLOAD",
    );
  }

  async reconcile(
    claim: PublicationReconciliationClaim,
  ): Promise<PublicationReconciliationResult> {
    const accessToken = await this.tokens.resolve({
      channelId: claim.channelId,
      platform: claim.platform,
      externalChannelRef: claim.externalChannelRef,
    });
    const remote = await this.transport.status({
      accessToken,
      publishId: claim.remotePublicationId,
    });
    if (
      [
        "PROCESSING_UPLOAD",
        "PROCESSING_DOWNLOAD",
        "SEND_TO_USER_INBOX",
      ].includes(remote.status)
    )
      return { state: "PENDING", remoteStatus: remote.status };
    if (remote.status === "PUBLISH_COMPLETE")
      return {
        state: "PUBLISHED",
        remoteStatus: remote.status,
        ...this.result(
          claim.remotePublicationId,
          claim.contentSha256,
          remote.postIds,
        ),
      };
    return {
      state: "FAILED",
      remoteStatus: remote.status,
      code: "TIKTOK_PUBLICATION_FAILED",
      message: `TikTok rejected the post (${safeCode(remote.failReason)}).`,
    };
  }

  private result(
    publishId: string,
    mediaSha256: string,
    postIds: string[],
  ): PublicationAdapterResult {
    return {
      adapterVersion: "tiktok-direct-post-v1",
      providerReceipt: { publishId, postIds, mediaSha256 },
      publicUrl: null,
    };
  }
}

function requireTikTokMetadata(
  snapshot: Record<string, unknown>,
  creator: TikTokCreatorInfo,
) {
  const consent = record(snapshot.consent);
  if (
    consent.version !== "tiktok-direct-post-consent-v1" ||
    consent.creatorUsername !== creator.creatorUsername ||
    typeof consent.confirmedAt !== "string" ||
    typeof consent.creatorInfoFetchedAt !== "string" ||
    Number.isNaN(Date.parse(consent.confirmedAt)) ||
    Number.isNaN(Date.parse(consent.creatorInfoFetchedAt)) ||
    Date.parse(consent.confirmedAt) < Date.parse(consent.creatorInfoFetchedAt)
  )
    throw new Error("TIKTOK_EXPLICIT_CONSENT_INVALID");
  const title = text(snapshot.title, 2200, "TIKTOK_TITLE_INVALID");
  const privacyLevel = text(
    snapshot.privacyLevel,
    64,
    "TIKTOK_PRIVACY_LEVEL_INVALID",
  );
  if (!creator.privacyLevelOptions.includes(privacyLevel))
    throw new Error("TIKTOK_PRIVACY_LEVEL_STALE");
  const disableComment = boolean(
    snapshot.disableComment,
    "TIKTOK_COMMENT_SETTING_INVALID",
  );
  const disableDuet = boolean(
    snapshot.disableDuet,
    "TIKTOK_DUET_SETTING_INVALID",
  );
  const disableStitch = boolean(
    snapshot.disableStitch,
    "TIKTOK_STITCH_SETTING_INVALID",
  );
  if (
    (creator.commentDisabled && !disableComment) ||
    (creator.duetDisabled && !disableDuet) ||
    (creator.stitchDisabled && !disableStitch)
  )
    throw new Error("TIKTOK_CREATOR_CAPABILITIES_STALE");
  return {
    title,
    privacyLevel,
    disableComment,
    disableDuet,
    disableStitch,
    brandContentToggle: boolean(
      snapshot.brandContentToggle,
      "TIKTOK_BRAND_SETTING_INVALID",
    ),
    brandOrganicToggle: boolean(
      snapshot.brandOrganicToggle,
      "TIKTOK_BRAND_SETTING_INVALID",
    ),
    ...(snapshot.isAigc === undefined
      ? {}
      : { isAigc: boolean(snapshot.isAigc, "TIKTOK_AIGC_SETTING_INVALID") }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("TIKTOK_EXPLICIT_CONSENT_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error(code);
  return value;
}
function boolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}
function safeCode(value: string | undefined): string {
  return value && /^[a-z0-9_]{1,128}$/i.test(value) ? value : "unknown";
}
function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
