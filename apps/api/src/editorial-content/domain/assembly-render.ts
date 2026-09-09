export const HORIZONTAL_RENDER_CONTRACT = "horizontal-render-v1" as const;
export const ASSEMBLY_PROGRESS_SCHEMA = "assembly-progress-v1" as const;

export type AssemblyRenderState =
  "QUEUED" | "PROCESSING" | "RETRY_WAIT" | "READY" | "FAILED_FINAL";

export type AssemblyRenderProgressPhase =
  | "DOWNLOAD"
  | "AUDIO_ANALYSIS"
  | "ENCODE"
  | "OUTPUT_PROBE"
  | "OUTPUT_HASH"
  | "UPLOAD"
  | "FINALIZE";

export interface AssemblyRenderInputSnapshot {
  id: string;
  role: "CUT" | "INTRO" | "OUTRO" | "ADVERTISEMENT" | "BANNER";
  revision: number | null;
  sha256: string;
  sizeBytes: bigint;
  durationMs: number | null;
}

export interface AssemblyRenderView {
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  cutPipelineJobId: string;
  cutResultArtifactId: string;
  assemblyRecipeId: string;
  recipeRevisionId: string;
  recipeRevision: number;
  configurationFingerprint: string;
  renderContractVersion: typeof HORIZONTAL_RENDER_CONTRACT;
  audioProfileVersion: "youtube-stereo-v1";
  encodingProfileVersion: "youtube-h264-v1";
  expectedDurationMs: number;
  inputs: AssemblyRenderInputSnapshot[];
  job: {
    id: string;
    revision: number;
    state: AssemblyRenderState;
    attempt: number;
    retryBudget: number;
    nextAttemptAt: Date | null;
    admissionReason: string | null;
    progress: {
      schemaVersion: typeof ASSEMBLY_PROGRESS_SCHEMA;
      attemptNumber: number;
      phase: AssemblyRenderProgressPhase;
      basisPoints: number;
      updatedAt: Date;
    } | null;
    failure: { code: string; message: string; retryable: boolean } | null;
  };
  result: {
    filename: string;
    sizeBytes: bigint;
    sha256: string;
    durationMs: number;
    width: number;
    height: number;
    fpsNumerator: number;
    fpsDenominator: number;
    videoCodec: string;
    pixelFormat: string;
    audioCodec: string;
    audioSampleRate: number;
    audioChannels: number;
    integratedLoudnessLufs: number | null;
    truePeakDbtp: number | null;
    normalizationProfileResult: string;
    ffmpegVersion: string;
    ffprobeVersion: string;
    completedAt: Date;
  } | null;
  createdAt: Date;
}

export class AssemblyRenderIdempotencyConflictError extends Error {}
export class AssemblyRenderNotFoundError extends Error {}
export class AssemblyRenderCursorInvalidError extends Error {}
export class AssemblyRenderCutNotReadyError extends Error {}
export class AssemblyRenderRecipeNotFoundError extends Error {}
export class AssemblyRenderRevisionConflictError extends Error {}
export class AssemblyRenderLineageInvalidError extends Error {}
export class AssemblyRenderProfileUnsupportedError extends Error {}
export class AssemblyRenderAuthorizationError extends Error {}
export class AssemblyRenderLimitsError extends Error {}
export class AssemblyRenderResultNotReadyError extends Error {}
export class AssemblyRenderUnavailableError extends Error {}
