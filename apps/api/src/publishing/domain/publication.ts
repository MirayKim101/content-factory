import type {
  PublicationPlatform,
  PublicationState,
} from "@content-factory/contracts";

export interface PublicationIntentView {
  id: string;
  projectId: string;
  channelId: string;
  approvalId: string;
  exportIntentId: string;
  exportResultId: string;
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

export class PublishingUnavailableError extends Error {}
export class PublicationScheduleInvalidError extends Error {}
export class PublicationTimezoneInvalidError extends Error {}
export class PublicationMetadataInvalidError extends Error {}
export class PublicationIdempotencyConflictError extends Error {}
export class PublicationLineageInvalidError extends Error {}
export class PublicationNotFoundError extends Error {}
export class PublicationCursorInvalidError extends Error {}
export class PublicationCancellationConflictError extends Error {}

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
