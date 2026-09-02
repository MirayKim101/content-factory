export type MediaJobType = "SOURCE_PROBE" | "CUT_SEGMENT";

export interface ClaimedMediaJob {
  id: string;
  type: MediaJobType;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceObjectKey: string;
  sourceSizeBytes: bigint;
  sourceSha256: string;
  originalFilename: string;
  leaseToken: string;
  attemptNumber: number;
  queueWaitMs: number;
  retryBudget: number;
  recipeVersion: string;
  segment?: {
    clientSegmentId: string;
    startMs: number;
    endMs: number;
  };
}

export class ControlledMediaError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "ControlledMediaError";
  }
}

export function leaseLostError(): ControlledMediaError {
  return new ControlledMediaError(
    "JOB_LEASE_LOST",
    "Право на обработку задания передано новой попытке.",
    true,
  );
}
