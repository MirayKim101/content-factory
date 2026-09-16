import type {
  FrameContextCapture,
  FrameMeasurement,
} from "@content-factory/contracts";

export const FRAME_EVIDENCE_REPOSITORY = Symbol("FRAME_EVIDENCE_REPOSITORY");

export interface FrameEvidenceView {
  id: string;
  pipelineJobId: string;
  identity: FrameContextCapture;
  contractVersion: string;
  recipeVersion: string;
  requestedPositionsMs: readonly number[];
  createdAt: Date;
  currentUse: {
    usableForGeneration: boolean;
    blockers: readonly string[];
    contextPolicyFingerprint: string | null;
  };
  contentAccess: {
    bytesReadable: boolean;
    blocker: "SOURCE_AUTHORIZATION_REQUIRED" | null;
  };
  job: {
    state: string;
    revision: number;
    attempt: number;
    nextAttemptAt: Date | null;
    admissionReason: string | null;
    failure: { code: string; message: string } | null;
    progress: {
      schemaVersion: "editorial-frame-progress-v1";
      phase: string;
      completedFrameCount: number;
      basisPoints: number;
    } | null;
  };
  frames: Array<{ id: string; measurement: FrameMeasurement }>;
}

export interface FrameEvidenceRepository {
  create(input: {
    cutPipelineJobId: string;
    sourceContextRevisionId: string;
    cutPromptRevisionId: string;
    idempotencyKey: string;
  }): Promise<string>;
  detail(intentId: string): Promise<FrameEvidenceView | null>;
  list(
    cutPipelineJobId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: FrameEvidenceView[]; nextCursor: string | null }>;
  content(
    intentId: string,
    frameId: string,
  ): Promise<{ objectKey: string; measurement: FrameMeasurement } | null>;
}
