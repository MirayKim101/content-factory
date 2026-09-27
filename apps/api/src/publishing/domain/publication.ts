import type {
  PublicationPlatform,
  PublicationContentKind,
  PublicationState,
} from "@content-factory/contracts";

export interface PublicationIntentView {
  id: string;
  projectId: string;
  channelId: string;
  contentKind: PublicationContentKind;
  approvalId: string | null;
  exportIntentId: string | null;
  exportResultId: string | null;
  verticalApprovalId: string | null;
  verticalResultId: string | null;
  platform: PublicationPlatform;
  scheduledAt: Date;
  timezone: string;
  metadataSnapshot: Record<string, unknown>;
  state: PublicationState;
  attemptCount: number;
  retryBudget: number;
  nextAttemptAt: Date | null;
  remotePublicationId: string | null;
  remoteStatus: string | null;
  failure: { code: string; message: string } | null;
  latestMetrics: {
    viewCount: string;
    likeCount: string | null;
    commentCount: string | null;
    shareCount: string | null;
    observedAt: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicationChannelView {
  id: string;
  projectId: string;
  platform: PublicationPlatform;
  displayName: string;
  externalChannelRef: string;
  timezone: string;
  state: "ENABLED" | "REVOKED";
  createdAt: Date;
  updatedAt: Date;
}

export class PublishingUnavailableError extends Error {}
export class PublicationScheduleInvalidError extends Error {}
export class PublicationTimezoneInvalidError extends Error {}
export class PublicationMetadataInvalidError extends Error {}
export class PublicationIdempotencyConflictError extends Error {}
export class PublicationLineageInvalidError extends Error {}
export class PublicationNotFoundError extends Error {}
export class PublicationCursorInvalidError extends Error {}
export class PublicationCancellationConflictError extends Error {}
export class PublicationRetryConflictError extends Error {}
export class PublicationOutcomeResolutionConflictError extends Error {}
export class PublicationChannelConflictError extends Error {}
export class TikTokCreatorInfoUnavailableError extends Error {}

export function requirePublicationTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone || timezone.length > 120)
    throw new PublicationTimezoneInvalidError();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new PublicationTimezoneInvalidError();
  }
  return timezone;
}

export function requirePublicationMetadata(
  value: unknown,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(value).length > 32_768
  )
    throw new PublicationMetadataInvalidError();
  return structuredClone(value as Record<string, unknown>);
}

export function requireTikTokPublicationMetadata(
  value: Record<string, unknown>,
  now: Date,
): void {
  const consent = value.consent;
  if (!consent || typeof consent !== "object" || Array.isArray(consent))
    throw new PublicationMetadataInvalidError();
  const record = consent as Record<string, unknown>;
  const fetchedAt = parseInstant(record.creatorInfoFetchedAt);
  const confirmedAt = parseInstant(record.confirmedAt);
  if (
    record.version !== "tiktok-direct-post-consent-v1" ||
    typeof record.creatorUsername !== "string" ||
    !record.creatorUsername.trim() ||
    record.creatorUsername.length > 256 ||
    !fetchedAt ||
    !confirmedAt ||
    confirmedAt.getTime() < fetchedAt.getTime() ||
    fetchedAt.getTime() < now.getTime() - 15 * 60 * 1000 ||
    fetchedAt.getTime() > now.getTime() + 60 * 1000 ||
    confirmedAt.getTime() > now.getTime() + 60 * 1000 ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 2200 ||
    typeof value.privacyLevel !== "string" ||
    !/^[A-Z_]{2,64}$/.test(value.privacyLevel) ||
    ![
      "disableComment",
      "disableDuet",
      "disableStitch",
      "brandContentToggle",
      "brandOrganicToggle",
    ].every((field) => typeof value[field] === "boolean") ||
    (value.isAigc !== undefined && typeof value.isAigc !== "boolean")
  )
    throw new PublicationMetadataInvalidError();
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function requirePublicationLabel(
  value: string,
  maximum: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum)
    throw new PublicationMetadataInvalidError();
  return normalized;
}

export function requirePublicationExternalChannelRef(
  platform: PublicationPlatform,
  value: string,
): string {
  const normalized = requirePublicationLabel(value, 255);
  if (
    (platform === "LOCAL_DRY_RUN" &&
      !/^local:[A-Za-z0-9._:-]{1,200}$/.test(normalized)) ||
    (platform === "YOUTUBE" && !/^UC[A-Za-z0-9_-]{20,40}$/.test(normalized)) ||
    (platform === "TIKTOK" && !/^[A-Za-z0-9._-]{1,128}$/.test(normalized))
  )
    throw new PublicationMetadataInvalidError();
  return normalized;
}
