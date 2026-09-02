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
    sourcePath: string;
    outputPath: string;
    startMs: number;
    endMs: number;
    signal: AbortSignal;
    onProgress(processedMs: number): void;
  }): Promise<{ version: string }>;
}
