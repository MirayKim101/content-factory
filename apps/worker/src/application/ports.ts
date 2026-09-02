import type { ClaimedMediaJob } from "../domain/media-job.js";

export interface MediaJobRepository {
  claim(
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedMediaJob | null>;
  heartbeat(
    jobId: string,
    leaseToken: string,
    leaseMs: number,
    processedMs?: number,
  ): Promise<boolean>;
  isLeaseActive(job: ClaimedMediaJob): Promise<boolean>;
  prepareAttemptOutput(job: ClaimedMediaJob, objectKey: string): Promise<void>;
  completeAttemptCleanup(
    job: ClaimedMediaJob,
    objectKey: string,
  ): Promise<void>;
  completeProbe(
    job: ClaimedMediaJob,
    durationMs: number,
    probeVersion: string,
  ): Promise<void>;
  completeCut(
    job: ClaimedMediaJob,
    result: {
      objectKey: string;
      filename: string;
      sizeBytes: bigint;
      sha256: string;
      etag?: string;
      storageVersion?: string;
      ffmpegVersion: string;
    },
  ): Promise<void>;
  fail(
    job: ClaimedMediaJob,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<"RETRY_SCHEDULED" | "FAILED_FINAL" | "LEASE_LOST">;
  close(): Promise<void>;
}

export interface WorkerObjectStorage {
  download(
    objectKey: string,
    destination: string,
    signal: AbortSignal,
  ): Promise<void>;
  upload(input: {
    objectKey: string;
    filePath: string;
    sha256: string;
    signal: AbortSignal;
  }): Promise<{ etag?: string; version?: string }>;
  delete(objectKey: string): Promise<void>;
  close(): void;
}

export interface SourceCacheIdentity {
  sourceId: string;
  sourceVersion: number;
  sha256: string;
  sizeBytes: bigint;
}

export interface SourceProbeResult {
  durationMs: number;
  version: string;
}

export interface SourceCacheHandle {
  path: string;
  outcome: "hit" | "fill" | "single_flight_wait";
  probe(
    load: (signal: AbortSignal) => Promise<SourceProbeResult>,
    signal: AbortSignal,
  ): Promise<{ result: SourceProbeResult; hit: boolean }>;
  release(): Promise<void>;
}

export interface SourceCache {
  acquire(input: {
    identity: SourceCacheIdentity;
    outputReservationBytes: bigint;
    safetyBytes: bigint;
    signal: AbortSignal;
    fill(destination: string, signal: AbortSignal): Promise<void>;
    onTelemetry?(event: SourceCacheTelemetry): void;
  }): Promise<SourceCacheHandle>;
  close(): Promise<void>;
}

export type TelemetryOutcome = "success" | "failure" | "aborted";

export interface SourceCacheTelemetry {
  phase:
    "cache_lookup" | "cache_wait" | "source_download" | "source_integrity_hash";
  durationMs: number;
  outcome: TelemetryOutcome;
  bytes?: string;
  cacheOutcome?: "hit" | "miss" | "single_flight_wait";
  evictionCount?: number;
  evictedBytes?: string;
  currentCacheBytes?: string;
}

export interface MediaJobPhaseTelemetry {
  event: "media_job_phase";
  workerId: string;
  jobId: string;
  sourceId: string;
  attemptNumber: number;
  phase:
    | "queue_wait"
    | "cache_lookup"
    | "cache_wait"
    | "source_download"
    | "source_integrity_hash"
    | "source_probe"
    | "encode"
    | "output_probe"
    | "output_hash"
    | "upload"
    | "total";
  durationMs: number;
  bytes?: string;
  cacheOutcome?: SourceCacheTelemetry["cacheOutcome"];
  probeCacheHit?: boolean;
  outcome: TelemetryOutcome;
  failureCode?: string;
  evictionCount?: number;
  evictedBytes?: string;
  currentCacheBytes?: string;
}

export type MediaJobTelemetry = (event: MediaJobPhaseTelemetry) => void;

export interface MediaProcessor {
  probe(
    filePath: string,
    signal: AbortSignal,
  ): Promise<{ durationMs: number; version: string }>;
  inspectOutput(
    filePath: string,
    signal: AbortSignal,
  ): Promise<{
    durationMs: number;
    hasVideo: boolean;
    frameRate?: number;
    version: string;
  }>;
  cut(input: {
    recipeVersion: string;
    sourcePath: string;
    outputPath: string;
    startMs: number;
    endMs: number;
    signal: AbortSignal;
    onProgress(processedMs: number): void;
  }): Promise<{ version: string }>;
}
