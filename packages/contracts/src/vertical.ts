export const VERTICAL_RENDER_CONTRACT_VERSION = "vertical-render-v1" as const;
export const VERTICAL_APPROVAL_VERSION = "human-vertical-approval-v1" as const;
export const VERTICAL_QUEUE_NAME = "vertical-render-v1" as const;
export const VERTICAL_JOB_SCHEMA_VERSION = 1 as const;
export const VERTICAL_OUTPUT = {
  width: 1080,
  height: 1920,
  framingMode: "CENTER_CROP",
} as const;

export interface VerticalJobReferenceV1 {
  schemaVersion: typeof VERTICAL_JOB_SCHEMA_VERSION;
  jobId: string;
}

export function parseVerticalJobReference(
  value: unknown,
): VerticalJobReferenceV1 {
  if (!value || typeof value !== "object")
    throw new Error("VERTICAL_JOB_INVALID");
  const payload = value as Record<string, unknown>;
  if (
    payload.schemaVersion !== VERTICAL_JOB_SCHEMA_VERSION ||
    typeof payload.jobId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.jobId,
    )
  )
    throw new Error("VERTICAL_JOB_INVALID");
  return { schemaVersion: VERTICAL_JOB_SCHEMA_VERSION, jobId: payload.jobId };
}
