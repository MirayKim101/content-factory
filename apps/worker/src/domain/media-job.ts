export type MediaJobType =
  "SOURCE_PROBE" | "CUT_SEGMENT" | "MONTAGE_ASSET_PROBE";

interface ClaimedMediaJobBase {
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

export type ClaimedMediaJob = ClaimedMediaJobBase &
  (
    | { type: "SOURCE_PROBE" | "CUT_SEGMENT"; montageAssetId?: never }
    | { type: "MONTAGE_ASSET_PROBE"; montageAssetId: string }
  );

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
