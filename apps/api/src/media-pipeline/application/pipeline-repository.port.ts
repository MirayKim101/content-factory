import type {
  CreateCutsResult,
  CutSegmentIntent,
  PipelineJobView,
} from "../domain/pipeline-job.js";
import type { JobDelivery } from "./job-dispatch.port.js";

export const PIPELINE_REPOSITORY = Symbol("PIPELINE_REPOSITORY");

export class CutIdempotencyConflictError extends Error {}
export class CutSourceNotReadyError extends Error {}
export class CutDurationUnavailableError extends Error {}
export class CutBoundsInvalidError extends Error {
  constructor(
    readonly clientSegmentId: string,
    readonly durationMs: number,
  ) {
    super("CUT_BOUNDS_INVALID");
  }
}

export interface PendingAttemptCleanup {
  jobId: string;
  attemptNumber: number;
  objectKey: string;
  updatedAt: Date;
}

export interface PipelineRepository {
  createCuts(input: {
    requestId: string;
    projectId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    segments: CutSegmentIntent[];
  }): Promise<{ result: CreateCutsResult; created: boolean }>;
  getJob(id: string): Promise<PipelineJobView | null>;
  listProjectCutJobs(
    projectId: string,
    limit: number,
  ): Promise<PipelineJobView[]>;
  getRunnableJobs(limit: number): Promise<JobDelivery[]>;
  getRunnableJobsByIds(jobIds: string[]): Promise<JobDelivery[]>;
  isDeliveryRunnable(delivery: JobDelivery): Promise<boolean>;
  ensureProbeJobs(limit: number): Promise<JobDelivery[]>;
  recoverExpiredLeases(limit: number): Promise<JobDelivery[]>;
  getPendingAttemptCleanups(limit: number): Promise<PendingAttemptCleanup[]>;
  reserveAttemptCleanup(cleanup: PendingAttemptCleanup): Promise<boolean>;
  completeAttemptCleanup(cleanup: PendingAttemptCleanup): Promise<void>;
  failAttemptCleanup(
    cleanup: PendingAttemptCleanup,
    code: string,
  ): Promise<void>;
  getSourceObject(projectId: string): Promise<{
    objectKey: string;
    sizeBytes: bigint;
    filename: string;
  } | null>;
  getResultObject(jobId: string): Promise<{
    objectKey: string;
    sizeBytes: bigint;
    filename: string;
  } | null>;
  requireProjectAuthorization(projectId: string): Promise<void>;
  requireJobAuthorization(jobId: string): Promise<void>;
}
