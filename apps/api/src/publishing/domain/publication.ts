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
  remotePublicationId: string | null;
  remoteStatus: string | null;
  failure: { code: string; message: string } | null;
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
export class PublicationChannelConflictError extends Error {}

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
    (platform === "YOUTUBE" && !/^UC[A-Za-z0-9_-]{20,40}$/.test(normalized))
  )
    throw new PublicationMetadataInvalidError();
  return normalized;
}
