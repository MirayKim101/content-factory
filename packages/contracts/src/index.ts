export const MEDIA_QUEUE_NAME = "media-v1";
export const MEDIA_JOB_SCHEMA_VERSION = 1 as const;

export interface MediaJobReferenceV1 {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  jobId: string;
}

export function parseMediaJobReference(value: unknown): MediaJobReferenceV1 {
  if (!value || typeof value !== "object") {
    throw new Error("JOB_PAYLOAD_INVALID");
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION ||
    typeof payload.jobId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.jobId,
    )
  ) {
    throw new Error("JOB_PAYLOAD_INVALID");
  }
  return { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, jobId: payload.jobId };
}
