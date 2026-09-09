export const CUT_RECIPE_VERSION = "horizontal-cut-v1" as const;
export const CUT_QUEUE_CONTRACT = "manual-cut-job-v1" as const;

export type CutJobState =
  "QUEUED" | "RUNNING" | "FAILED_RETRYABLE" | "SUCCEEDED" | "FAILED_FINAL";

export type CutAttemptState =
  "RUNNING" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "SUCCEEDED" | "ABANDONED";

export interface CutProgress {
  current: bigint;
  total: bigint;
  unit: "BYTES" | "MILLISECONDS";
}

export interface CutJobView {
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceSha256: string;
  startMs: number;
  endMs: number;
  recipeVersion: typeof CUT_RECIPE_VERSION;
  state: CutJobState;
  stage: string;
  progress: CutProgress | null;
  attempts: number;
  queueReason: string | null;
  admissionDeadlineAt: Date;
  failure: { code: string; message: string } | null;
  revision: number;
  artifact: null | {
    id: string;
    sizeBytes: bigint;
    sha256: string;
    contentType: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface CutQueueMessageV1 {
  jobId: string;
}

export function isCutQueueMessageV1(
  value: unknown,
): value is CutQueueMessageV1 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.jobId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record.jobId,
    )
  );
}

export interface PageCursor {
  createdAt: Date;
  id: string;
}

export function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    }),
  ).toString("base64url");
}

export function decodePageCursor(value: string): PageCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.createdAt !== "string" ||
      typeof candidate.id !== "string" ||
      Object.keys(candidate).length !== 2
    )
      return null;
    const createdAt = new Date(candidate.createdAt);
    if (
      !Number.isFinite(createdAt.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.id,
      )
    )
      return null;
    return { createdAt, id: candidate.id };
  } catch {
    return null;
  }
}
