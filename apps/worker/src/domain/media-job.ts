export type MediaJobType =
  | "SOURCE_PROBE"
  | "CUT_SEGMENT"
  | "MONTAGE_ASSET_PROBE"
  | "ASSEMBLE_HORIZONTAL";

interface ClaimedMediaJobBase {
  id: string;
  type: MediaJobType;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
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

export interface AssemblyRenderInput {
  id: string;
  role: "CUT" | "INTRO" | "OUTRO" | "ADVERTISEMENT" | "BANNER";
  ordinal: number;
  objectKey: string;
  sizeBytes: bigint;
  sha256: string;
  durationMs: number | null;
  hasAudio: boolean | null;
  startMs: number | null;
  endMs: number | null;
  position: "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT" | null;
}

export interface AssemblyRenderPlan {
  intentId: string;
  recipeRevisionId: string;
  recipeRevision: number;
  configurationFingerprint: string;
  renderContractVersion: "horizontal-render-v1";
  audioProfileVersion: "youtube-stereo-v1";
  encodingProfileVersion: "youtube-h264-v1";
  expectedDurationMs: number;
  advertisementInsertAtMs: number | null;
  cta: {
    text: string;
    startMs: number;
    endMs: number;
    position: "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT";
  } | null;
  inputs: AssemblyRenderInput[];
}

interface StoredInputIdentity {
  sourceObjectKey: string;
  sourceSizeBytes: bigint;
  sourceSha256: string;
  originalFilename: string;
}

export type ClaimedMediaJob = ClaimedMediaJobBase &
  (
    | (StoredInputIdentity & {
        type: "SOURCE_PROBE";
        montageAssetId?: never;
        assemblyRenderPlan?: never;
      })
    | (StoredInputIdentity & {
        type: "CUT_SEGMENT";
        montageAssetId?: never;
        assemblyRenderPlan?: never;
      })
    | (StoredInputIdentity & {
        type: "MONTAGE_ASSET_PROBE";
        montageAssetId: string;
        assemblyRenderPlan?: never;
      })
    | {
        type: "ASSEMBLE_HORIZONTAL";
        assemblyRenderPlan: AssemblyRenderPlan;
        montageAssetId?: never;
      }
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
