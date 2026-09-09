import type { CutJobView, PageCursor } from "./domain.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface CreateCutJobInput {
  id: string;
  projectId: string;
  idempotencyKey: string;
  startMs: number;
  endMs: number;
  now: Date;
  admissionDeadlineAt: Date;
  maxAttempts: number;
}

export type CreateCutJobResult =
  | { outcome: "CREATED" | "EXISTING"; job: CutJobView }
  | {
      outcome:
        | "PROJECT_NOT_FOUND"
        | "SOURCE_NOT_READY"
        | "SOURCE_NOT_AUTHORIZED"
        | "IDEMPOTENCY_CONFLICT";
    };

export type AuthorizedMediaResult =
  | {
      outcome: "READY";
      media: {
        objectKey: string;
        sizeBytes: bigint;
        contentType: string;
        filename: string;
      };
    }
  | {
      outcome:
        "PROJECT_NOT_FOUND" | "SOURCE_NOT_READY" | "SOURCE_NOT_AUTHORIZED";
    };

export type CutJobReadResult =
  | { outcome: "FOUND"; job: CutJobView }
  | {
      outcome:
        | "PROJECT_NOT_FOUND"
        | "SOURCE_NOT_READY"
        | "SOURCE_NOT_AUTHORIZED"
        | "CUT_JOB_NOT_FOUND";
    };

export interface ClaimedCut {
  job: CutJobView;
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  claimRevision: number;
  leaseExpiresAt: Date;
  source: {
    objectKey: string;
    sizeBytes: bigint;
    contentType: string;
  };
}

export type ClaimCutResult =
  | { outcome: "CLAIMED"; claim: ClaimedCut }
  | {
      outcome:
        | "NOT_RUNNABLE"
        | "NO_SLOT"
        | "NO_CAPACITY"
        | "SOURCE_NOT_AUTHORIZED"
        | "ATTEMPTS_EXHAUSTED";
    };

export interface ActiveLease {
  jobId: string;
  attemptId: string;
  leaseToken: string;
  claimRevision: number;
}

export interface CompletedArtifact {
  id: string;
  objectKey: string;
  sizeBytes: bigint;
  sha256: string;
  contentType: string;
  storageEtag?: string;
  storageVersion?: string;
}

export interface PendingOutputCleanup {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  objectKey: string;
}

export interface CutJobRepository {
  create(input: CreateCutJobInput): Promise<CreateCutJobResult>;
  get(projectId: string, jobId: string): Promise<CutJobReadResult>;
  list(
    projectId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<
    | { outcome: "FOUND"; jobs: CutJobView[] }
    | {
        outcome:
          "PROJECT_NOT_FOUND" | "SOURCE_NOT_READY" | "SOURCE_NOT_AUTHORIZED";
      }
  >;
  getAuthorizedSourceMedia(projectId: string): Promise<AuthorizedMediaResult>;
  getReadyDownload(
    projectId: string,
    jobId: string,
  ): Promise<
    AuthorizedMediaResult | { outcome: "CUT_JOB_NOT_FOUND" | "CUT_NOT_READY" }
  >;
  getAdmission(jobId: string): Promise<null | {
    sourceSizeBytes: bigint;
    requestedDurationMs: number;
  }>;
  claim(input: {
    jobId: string;
    attemptId: string;
    leaseToken: string;
    now: Date;
    leaseMs: number;
    reservedScratchBytes: bigint;
    scratchCapacityBytes: bigint;
    heavyConcurrency: number;
  }): Promise<ClaimCutResult>;
  heartbeat(lease: ActiveLease, now: Date, leaseMs: number): Promise<boolean>;
  recordProgress(
    lease: ActiveLease,
    stage: string,
    current: bigint,
    total: bigint,
    unit: "BYTES" | "MILLISECONDS",
    now: Date,
  ): Promise<boolean>;
  persistOutputIntent(
    lease: ActiveLease,
    objectKey: string,
    now: Date,
  ): Promise<boolean>;
  complete(
    lease: ActiveLease,
    artifact: CompletedArtifact,
    now: Date,
  ): Promise<boolean>;
  fail(
    lease: ActiveLease,
    input: {
      retryable: boolean;
      code: string;
      message: string;
      now: Date;
      retryDelayMs: number;
    },
  ): Promise<boolean>;
  markScratchWait(
    jobId: string,
    now: Date,
  ): Promise<"WAITING" | "DEADLINE" | "NOT_RUNNABLE">;
  failWithoutAttempt(
    jobId: string,
    code: string,
    message: string,
  ): Promise<boolean>;
  reconcileExpired(now: Date): Promise<string[]>;
  findRunnable(now: Date, limit: number): Promise<string[]>;
  findPendingOutputCleanup(limit: number): Promise<PendingOutputCleanup[]>;
  findScratchCleanupAttemptIds(candidateIds: string[]): Promise<string[]>;
  completeOutputCleanup(attemptId: string, now: Date): Promise<void>;
  failOutputCleanup(attemptId: string, safeCode: string): Promise<void>;
}

export interface CutQueuePublisher {
  publish(jobId: string): Promise<void>;
}

export interface WorkerObjectStorage {
  downloadToFile(input: {
    objectKey: string;
    filePath: string;
    signal: AbortSignal;
    onProgress(progress: { current: bigint; total: bigint }): void;
  }): Promise<void>;
  putFile(input: {
    objectKey: string;
    filePath: string;
    contentType: string;
    sha256: string;
    signal: AbortSignal;
    onProgress(progress: { current: bigint; total: bigint }): void;
  }): Promise<{ etag?: string; version?: string }>;
  headObject(objectKey: string, signal?: AbortSignal): Promise<boolean>;
  deleteObject(objectKey: string, signal?: AbortSignal): Promise<void>;
}

export interface MediaRuntime {
  probe(input: { inputPath: string; signal: AbortSignal }): Promise<{
    durationMs: number;
    streams: Array<{ type: string; codec?: string }>;
  }>;
  cut(input: {
    inputPath: string;
    outputPath: string;
    startMs: number;
    endMs: number;
    recipe: "horizontal-cut-v1";
    signal: AbortSignal;
    onProgress(encodedMs: number): void;
  }): Promise<void>;
}

export interface ScratchCapacity {
  inspect(
    requiredBytes: bigint,
  ): Promise<
    | { outcome: "AVAILABLE"; usableBytes: bigint }
    | { outcome: "TEMPORARY_PRESSURE" }
    | { outcome: "IMPOSSIBLE" }
  >;
}

export interface WorkerEventSink {
  emit(event: {
    name: string;
    jobId?: string;
    attemptNumber?: number;
    safeCode?: string;
    retryable?: boolean;
  }): void;
}
