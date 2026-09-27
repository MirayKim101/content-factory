export const PUBLICATION_JOB_SCHEMA_VERSION = 1 as const;
export const PUBLICATION_QUEUE_NAME = "publication-v1" as const;

export const PUBLICATION_PLATFORMS = [
  "LOCAL_DRY_RUN",
  "YOUTUBE",
  "TIKTOK",
] as const;
export type PublicationPlatform = (typeof PUBLICATION_PLATFORMS)[number];

export const PUBLICATION_STATES = [
  "SCHEDULED",
  "QUEUED",
  "PROCESSING",
  "UNKNOWN_REMOTE_STATE",
  "DRY_RUN_READY",
  "PUBLISHED",
  "FAILED_FINAL",
  "CANCELED",
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export interface PublicationJobReferenceV1 {
  schemaVersion: typeof PUBLICATION_JOB_SCHEMA_VERSION;
  publicationIntentId: string;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePublicationJobReference(
  value: unknown,
): PublicationJobReferenceV1 {
  if (!value || typeof value !== "object")
    throw new Error("PUBLICATION_JOB_PAYLOAD_INVALID");
  const payload = value as Record<string, unknown>;
  if (
    payload.schemaVersion !== PUBLICATION_JOB_SCHEMA_VERSION ||
    typeof payload.publicationIntentId !== "string" ||
    !UUID_V4.test(payload.publicationIntentId)
  )
    throw new Error("PUBLICATION_JOB_PAYLOAD_INVALID");
  return {
    schemaVersion: PUBLICATION_JOB_SCHEMA_VERSION,
    publicationIntentId: payload.publicationIntentId,
  };
}

const transitions: Readonly<Record<PublicationState, readonly PublicationState[]>> = {
  SCHEDULED: ["QUEUED", "CANCELED"],
  QUEUED: ["PROCESSING", "CANCELED"],
  PROCESSING: [
    "UNKNOWN_REMOTE_STATE",
    "DRY_RUN_READY",
    "PUBLISHED",
    "FAILED_FINAL",
  ],
  UNKNOWN_REMOTE_STATE: ["PROCESSING", "PUBLISHED", "FAILED_FINAL"],
  DRY_RUN_READY: [],
  PUBLISHED: [],
  FAILED_FINAL: [],
  CANCELED: [],
};

export function canTransitionPublication(
  from: PublicationState,
  to: PublicationState,
): boolean {
  return transitions[from].includes(to);
}

export function isTerminalPublicationState(value: PublicationState): boolean {
  return ["DRY_RUN_READY", "PUBLISHED", "FAILED_FINAL", "CANCELED"].includes(
    value,
  );
}

export function requirePublicationSchedule(value: string, now: Date): string {
  const scheduledAt = new Date(value);
  if (
    Number.isNaN(scheduledAt.getTime()) ||
    scheduledAt.getTime() < now.getTime()
  )
    throw new Error("PUBLICATION_SCHEDULE_INVALID");
  return scheduledAt.toISOString();
}
