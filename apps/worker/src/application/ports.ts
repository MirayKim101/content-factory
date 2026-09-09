import type {
  AssemblyRenderPlan,
  ClaimedMediaJob,
  EditorialExportPlan,
} from "../domain/media-job.js";
import type { MontageProbeResultV1 } from "@content-factory/contracts";

export interface MediaJobRepository {
  getAssemblyResourcePlan(jobId: string): Promise<{
    requiredScratchBytes: bigint;
  } | null>;
  deferAssemblyAdmission(
    jobId: string,
    reason: string,
    nextAttemptAt: Date,
  ): Promise<void>;
  prepareExportScratch(
    job: ClaimedMediaJob,
    marker: {
      directoryName: string;
      leaseHash: string;
      reservedBytes: bigint;
    },
  ): Promise<void>;
  clearExportScratch(
    job: ClaimedMediaJob,
    directoryName: string,
  ): Promise<void>;
  listActiveExportScratchReservations(): Promise<
    Array<{
      jobId: string;
      attemptNumber: number;
      directoryName: string;
      leaseHash: string;
      reservedBytes: bigint;
    }>
  >;
  inspectExportScratchLease(input: {
    jobId: string;
    attemptNumber: number;
    leaseHash: string;
    directoryName: string;
  }): Promise<"ACTIVE" | "INACTIVE" | "UNKNOWN">;
  clearReconciledExportScratch(input: {
    jobId: string;
    attemptNumber: number;
    directoryName: string;
    leaseHash: string;
  }): Promise<void>;
  completeMontageProbe(
    job: ClaimedMediaJob,
    result: MontageProbeResultV1,
  ): Promise<void>;
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
  updateAssemblyProgress(
    job: ClaimedMediaJob,
    phase:
      | "DOWNLOAD"
      | "READ_INPUTS"
      | "WRITE_ARCHIVE"
      | "AUDIO_ANALYSIS"
      | "ENCODE"
      | "OUTPUT_PROBE"
      | "OUTPUT_HASH"
      | "UPLOAD"
      | "FINALIZE",
    basisPoints: number,
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
  completeAssembly(
    job: ClaimedMediaJob,
    result: {
      objectKey: string;
      filename: string;
      sizeBytes: bigint;
      sha256: string;
      etag?: string;
      storageVersion?: string;
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
      ffmpegVersion: string;
      ffprobeVersion: string;
      integratedLoudnessLufs: number | null;
      truePeakDbtp: number | null;
      normalizationProfileResult: string;
    },
  ): Promise<void>;
  completeEditorialExport(
    job: ClaimedMediaJob,
    result: {
      objectKey: string;
      filename: string;
      sizeBytes: bigint;
      sha256: string;
      etag?: string;
      storageVersion?: string;
      manifest: unknown;
    },
  ): Promise<void>;
  isAssemblyResultAccepted(
    job: ClaimedMediaJob,
    objectKey: string,
  ): Promise<boolean>;
  isCutResultAccepted(
    job: ClaimedMediaJob,
    objectKey: string,
  ): Promise<boolean>;
  isEditorialExportResultAccepted(
    job: ClaimedMediaJob,
    objectKey: string,
  ): Promise<boolean>;
  findTerminalMediaScratchDirectories(
    candidates: Array<{
      directoryName: string;
      jobId: string;
      attemptNumber: number;
    }>,
  ): Promise<string[]>;
  fail(
    job: ClaimedMediaJob,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<"RETRY_SCHEDULED" | "FAILED_FINAL" | "LEASE_LOST">;
  close(): Promise<void>;
}

export interface AssemblyRenderer {
  render(input: {
    plan: AssemblyRenderPlan;
    files: Map<string, string>;
    scratchDirectory: string;
    outputPath: string;
    fontPath: string;
    signal: AbortSignal;
    onProgress(phase: "AUDIO_ANALYSIS" | "ENCODE", processedMs: number): void;
  }): Promise<AssemblyEncodedOutput>;
  inspectOutput(input: {
    outputPath: string;
    expectedDurationMs: number;
    encoded: AssemblyEncodedOutput;
    signal: AbortSignal;
  }): Promise<AssemblyRenderedOutput>;
  verifyCapabilities(fontPath: string): Promise<void>;
}

export interface AssemblyEncodedOutput {
  canvas: {
    width: number;
    height: number;
    fpsNumerator: number;
    fpsDenominator: number;
  };
  outputLoudness: {
    integratedLoudnessLufs: number;
    truePeakDbtp: number;
  } | null;
}

export interface AssemblyRenderedOutput {
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
  ffmpegVersion: string;
  ffprobeVersion: string;
  integratedLoudnessLufs: number | null;
  truePeakDbtp: number | null;
  normalizationProfileResult: string;
}

export interface WorkerObjectStorage {
  read(objectKey: string, signal: AbortSignal): Promise<NodeJS.ReadableStream>;
  download(
    objectKey: string,
    destination: string,
    signal: AbortSignal,
    maxBytes?: bigint,
  ): Promise<void>;
  upload(input: {
    objectKey: string;
    filePath: string;
    sha256: string;
    sizeBytes?: bigint;
    contentType?: string;
    uploadMode?: "MULTIPART" | "SINGLE_REQUEST";
    signal: AbortSignal;
    onProgress?(uploadedBytes: bigint): void;
  }): Promise<{ etag?: string; version?: string }>;
  delete(objectKey: string): Promise<void>;
  close(): void;
}

export interface PackageExporterResult {
  manifest: unknown;
  archiveBytes: bigint;
}

export interface PackageExporter {
  export(input: {
    plan: EditorialExportPlan;
    outputPath: string;
    signal: AbortSignal;
    openInput(objectKey: string): Promise<NodeJS.ReadableStream>;
    onProgress(event: {
      phase: "READ_INPUTS" | "WRITE_ARCHIVE";
      bytes: bigint;
      totalBytes: bigint;
    }): void;
  }): Promise<PackageExporterResult>;
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
  scratchReservationBytes?: string;
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
    | "archive"
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
  scratchReservationBytes?: string;
  scratchPeakBytes?: string;
}

export type MediaJobTelemetry = (event: MediaJobPhaseTelemetry) => void;

export interface MediaProcessor {
  inspectMontage(
    filePath: string,
    signal: AbortSignal,
  ): Promise<MontageProbeResultV1>;
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
