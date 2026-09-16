import type {
  FrameContextCapture,
  FrameMeasurement,
  FrameProgressPhase,
} from "@content-factory/contracts";

export interface FrameWorkPlan {
  intentId: string;
  jobId: string;
  capture: FrameContextCapture;
  inputObjectKey: string;
  contextPolicyFingerprint: string;
}
export interface ClaimedFrameWork extends FrameWorkPlan {
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  workDeadlineAt: Date;
  scratchDirectoryName: string;
  scratchReservedBytes: number;
}
export interface FramePreparedOutput {
  id: string;
  ordinal: number;
  objectKey: string;
}
export interface FrameJobRepository {
  initializePool(capacity: number): Promise<void>;
  plan(jobId: string): Promise<FrameWorkPlan | null>;
  rejectPending(
    plan: FrameWorkPlan,
    code: string,
    message: string,
  ): Promise<void>;
  claim(input: {
    plan: FrameWorkPlan;
    workerId: string;
    leaseMs: number;
    workDeadlineMs: number;
    scratchDirectoryName: string;
    scratchReservedBytes: number;
    availableScratchBytes: number;
  }): Promise<ClaimedFrameWork | null>;
  heartbeat(work: ClaimedFrameWork, leaseMs: number): Promise<boolean>;
  admitInputRead(work: ClaimedFrameWork): Promise<void>;
  progress(
    work: ClaimedFrameWork,
    phase: FrameProgressPhase,
    completedFrames: number,
    basisPoints: number,
  ): Promise<void>;
  prepareOutput(
    work: ClaimedFrameWork,
    ordinal: number,
  ): Promise<FramePreparedOutput>;
  uploaded(
    work: ClaimedFrameWork,
    output: FramePreparedOutput,
    measurement: FrameMeasurement,
  ): Promise<void>;
  uploadSettled(
    work: ClaimedFrameWork,
    output: FramePreparedOutput,
  ): Promise<void>;
  finalize(work: ClaimedFrameWork): Promise<void>;
  accepted(work: ClaimedFrameWork): Promise<boolean>;
  executionStopped(work: ClaimedFrameWork): Promise<void>;
  fail(
    work: ClaimedFrameWork,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<void>;
  cleanupCandidates(
    limit: number,
  ): Promise<Array<{ outputId: string; objectKey: string }>>;
  cleaned(outputId: string, errorCode?: string): Promise<void>;
  recover(limit: number): Promise<void>;
  scratchCandidates(
    limit: number,
  ): Promise<Array<{ attemptId: string; directoryName: string }>>;
  scratchCleaned(attemptId: string, directoryName: string): Promise<void>;
  close(): Promise<void>;
}
