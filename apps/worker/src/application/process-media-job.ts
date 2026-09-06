import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

import {
  ControlledMediaError,
  leaseLostError,
  type ClaimedMediaJob,
} from "../domain/media-job.js";
import type {
  MediaJobPhaseTelemetry,
  AssemblyRenderer,
  MediaJobTelemetry,
  MediaJobRepository,
  MediaProcessor,
  SourceCache,
  SourceCacheHandle,
  TelemetryOutcome,
  WorkerObjectStorage,
} from "./ports.js";

export interface MediaWorkerLimits {
  scratchDirectory: string;
  scratchSafetyBytes: bigint;
  leaseMs: number;
  jobTimeoutMs: number;
  assemblyFontPath?: string;
}

export class ProcessMediaJob {
  private reservedScratchBytes = 0n;

  constructor(
    private readonly repository: MediaJobRepository,
    private readonly storage: WorkerObjectStorage,
    private readonly processor: MediaProcessor,
    private readonly sourceCache: SourceCache,
    private readonly workerId: string,
    private readonly limits: MediaWorkerLimits,
    private readonly telemetry: MediaJobTelemetry = () => undefined,
    private readonly assemblyRenderer?: AssemblyRenderer,
  ) {}

  async execute(jobId: string): Promise<void> {
    let scratchReservation = 0n;
    const resourcePlan = await this.repository.getAssemblyResourcePlan(jobId);
    if (resourcePlan) {
      const disk = await statfs(this.limits.scratchDirectory, { bigint: true });
      const available = disk.bavail * disk.bsize;
      const required =
        resourcePlan.requiredScratchBytes + this.limits.scratchSafetyBytes;
      if (available - this.reservedScratchBytes < required) {
        await this.repository.deferAssemblyAdmission(
          jobId,
          "INSUFFICIENT_SCRATCH",
          new Date(Date.now() + 30_000),
        );
        return;
      }
      this.reservedScratchBytes += resourcePlan.requiredScratchBytes;
      scratchReservation = resourcePlan.requiredScratchBytes;
    }
    let job: ClaimedMediaJob | null;
    try {
      job = await this.repository.claim(
        jobId,
        this.workerId,
        this.limits.leaseMs,
      );
    } catch (error) {
      this.reservedScratchBytes -= scratchReservation;
      throw error;
    }
    if (!job) {
      this.reservedScratchBytes -= scratchReservation;
      return;
    }
    const totalStartedAt = performance.now();
    const abort = new AbortController();
    const timeout = setTimeout(
      () =>
        abort.abort(
          new ControlledMediaError(
            "MEDIA_JOB_TIMEOUT",
            "Обработка превысила допустимое время.",
            true,
          ),
        ),
      job.type === "MONTAGE_ASSET_PROBE"
        ? Math.min(120_000, this.limits.jobTimeoutMs)
        : this.limits.jobTimeoutMs,
    );
    timeout.unref();
    let scratch: string | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatRunning = false;
    let heartbeatStopped = false;
    let lastProgress = -1;
    let uploadedObjectKey: string | undefined;
    let finalized = false;
    let succeeded = false;
    let failureCode: string | undefined;
    let cachedSource: SourceCacheHandle | undefined;
    let assemblyPhase:
      | "DOWNLOAD"
      | "AUDIO_ANALYSIS"
      | "ENCODE"
      | "OUTPUT_PROBE"
      | "OUTPUT_HASH"
      | "UPLOAD"
      | "FINALIZE"
      | undefined;
    let assemblyBasisPoints = 0;

    const recordPhase = (
      phase: MediaJobPhaseTelemetry["phase"],
      durationMs: number,
      outcome: TelemetryOutcome,
      details: Omit<
        Partial<MediaJobPhaseTelemetry>,
        | "event"
        | "workerId"
        | "jobId"
        | "sourceId"
        | "attemptNumber"
        | "phase"
        | "durationMs"
        | "outcome"
      > = {},
    ): void => {
      try {
        this.telemetry({
          event: "media_job_phase",
          workerId: this.workerId,
          jobId: job.id,
          sourceId: job.sourceId,
          attemptNumber: job.attemptNumber,
          phase,
          durationMs,
          outcome,
          ...details,
        });
      } catch {
        // Telemetry must never change media processing behavior.
      }
    };

    const measurePhase = async <T>(
      phase: MediaJobPhaseTelemetry["phase"],
      work: () => Promise<T>,
      successDetails: (
        result: T,
      ) => Omit<
        Partial<MediaJobPhaseTelemetry>,
        | "event"
        | "workerId"
        | "jobId"
        | "sourceId"
        | "attemptNumber"
        | "phase"
        | "durationMs"
        | "outcome"
      > = () => ({}),
    ): Promise<T> => {
      const startedAt = performance.now();
      try {
        const result = await work();
        recordPhase(
          phase,
          elapsed(startedAt),
          "success",
          successDetails(result),
        );
        return result;
      } catch (error) {
        recordPhase(
          phase,
          elapsed(startedAt),
          telemetryOutcome(error, abort.signal),
          {
            failureCode: phaseFailureCode(error, abort.signal),
          },
        );
        throw error;
      }
    };

    recordPhase("queue_wait", job.queueWaitMs, "success");

    const heartbeat = async (): Promise<void> => {
      if (heartbeatStopped || heartbeatRunning || abort.signal.aborted) return;
      heartbeatRunning = true;
      try {
        const active = await this.repository.heartbeat(
          job.id,
          job.leaseToken,
          this.limits.leaseMs,
          lastProgress < 0 ? undefined : lastProgress,
        );
        if (!active) abort.abort(leaseLostError());
        if (
          active &&
          job.type === "ASSEMBLE_HORIZONTAL" &&
          assemblyPhase &&
          !(await this.repository.updateAssemblyProgress(
            job,
            assemblyPhase,
            assemblyBasisPoints,
          ))
        ) {
          abort.abort(leaseLostError());
        }
      } catch {
        abort.abort(
          new ControlledMediaError(
            "MEDIA_HEARTBEAT_FAILED",
            "Не удалось подтвердить право на обработку задания.",
            true,
          ),
        );
      } finally {
        heartbeatRunning = false;
      }
    };

    try {
      if (
        ![
          "SOURCE_PROBE",
          "CUT_SEGMENT",
          "MONTAGE_ASSET_PROBE",
          "ASSEMBLE_HORIZONTAL",
        ].includes(job.type)
      )
        throw new ControlledMediaError(
          "MEDIA_JOB_TYPE_UNSUPPORTED",
          "Unsupported job type.",
          false,
        );
      await heartbeat();
      if (abort.signal.aborted) throw abort.signal.reason;
      heartbeatTimer = setInterval(
        () => void heartbeat(),
        Math.max(1_000, Math.floor(this.limits.leaseMs / 3)),
      );
      heartbeatTimer.unref();

      if (job.type === "ASSEMBLE_HORIZONTAL") {
        if (!this.assemblyRenderer || !this.limits.assemblyFontPath) {
          throw new ControlledMediaError(
            "ASSEMBLY_CAPABILITY_UNAVAILABLE",
            "Worker cannot render the configured horizontal assembly profile.",
            false,
          );
        }
        scratch = await mkdtemp(
          join(this.limits.scratchDirectory, "content-factory-assembly-"),
        );
        const files = new Map<string, string>();
        const totalInputBytes = job.assemblyRenderPlan.inputs.reduce(
          (sum, value) => sum + value.sizeBytes,
          0n,
        );
        let downloadedBytes = 0n;
        assemblyPhase = "DOWNLOAD";
        await this.updateAssemblyProgress(job, assemblyPhase, 0);
        await measurePhase(
          "source_download",
          async () => {
            for (const [
              index,
              input,
            ] of job.assemblyRenderPlan.inputs.entries()) {
              const path = join(scratch!, `input-${index}`);
              await this.storage.download(
                input.objectKey,
                path,
                abort.signal,
                input.sizeBytes,
              );
              const [identity, file] = await Promise.all([
                hashFile(path, abort.signal),
                stat(path),
              ]);
              if (
                identity !== input.sha256 ||
                BigInt(file.size) !== input.sizeBytes
              ) {
                throw new ControlledMediaError(
                  "ASSEMBLY_INPUT_IDENTITY_MISMATCH",
                  "Один из входов сборки не совпадает с сохранённым снимком.",
                  false,
                );
              }
              files.set(input.id, path);
              downloadedBytes += input.sizeBytes;
              assemblyBasisPoints = Number(
                totalInputBytes === 0n
                  ? 1_500n
                  : (downloadedBytes * 1_500n) / totalInputBytes,
              );
              await this.updateAssemblyProgress(
                job,
                "DOWNLOAD",
                assemblyBasisPoints,
              );
            }
          },
          () => ({ bytes: downloadedBytes.toString() }),
        );
        const outputPath = join(scratch, "assembled.mp4");
        const encoded = await measurePhase("encode", () =>
          this.assemblyRenderer!.render({
            plan: job.assemblyRenderPlan,
            files,
            scratchDirectory: scratch!,
            outputPath,
            fontPath: this.limits.assemblyFontPath!,
            signal: abort.signal,
            onProgress: (phase, processedMs) => {
              assemblyPhase = phase;
              const fraction = Math.max(
                0,
                Math.min(
                  1,
                  processedMs / job.assemblyRenderPlan.expectedDurationMs,
                ),
              );
              assemblyBasisPoints =
                phase === "AUDIO_ANALYSIS"
                  ? 1_500 + Math.round(fraction * 1_500)
                  : 3_000 + Math.round(fraction * 5_500);
            },
          }),
        );
        assemblyPhase = "OUTPUT_PROBE";
        assemblyBasisPoints = 8_700;
        await this.updateAssemblyProgress(
          job,
          assemblyPhase,
          assemblyBasisPoints,
        );
        const rendered = await measurePhase("output_probe", () =>
          this.assemblyRenderer!.inspectOutput({
            outputPath,
            expectedDurationMs: job.assemblyRenderPlan.expectedDurationMs,
            encoded,
            signal: abort.signal,
          }),
        );
        assemblyPhase = "OUTPUT_HASH";
        assemblyBasisPoints = 8_800;
        await this.updateAssemblyProgress(
          job,
          assemblyPhase,
          assemblyBasisPoints,
        );
        const outputStat = await stat(outputPath);
        const sha256 = await measurePhase(
          "output_hash",
          () => hashFile(outputPath, abort.signal),
          () => ({ bytes: outputStat.size.toString() }),
        );
        assemblyBasisPoints = 9_100;
        await this.updateAssemblyProgress(
          job,
          assemblyPhase,
          assemblyBasisPoints,
        );
        await this.assertActiveLease(job);
        const objectKey = `sources/${job.projectId}/assembly/${job.id}/attempt-${job.attemptNumber}-${safeIdentity(job.leaseToken)}.mp4`;
        await this.repository.prepareAttemptOutput(job, objectKey);
        uploadedObjectKey = objectKey;
        assemblyPhase = "UPLOAD";
        assemblyBasisPoints = 9_100;
        await this.updateAssemblyProgress(
          job,
          assemblyPhase,
          assemblyBasisPoints,
        );
        const receipt = await measurePhase(
          "upload",
          () =>
            this.storage.upload({
              objectKey,
              filePath: outputPath,
              sha256,
              signal: abort.signal,
            }),
          () => ({ bytes: outputStat.size.toString() }),
        );
        assemblyBasisPoints = 9_800;
        await this.updateAssemblyProgress(
          job,
          assemblyPhase,
          assemblyBasisPoints,
        );
        await this.assertActiveLease(job);
        assemblyPhase = "FINALIZE";
        assemblyBasisPoints = 9_900;
        await this.updateAssemblyProgress(
          job,
          assemblyPhase,
          assemblyBasisPoints,
        );
        await this.repository.completeAssembly(job, {
          objectKey,
          filename: `horizontal-${job.assemblyRenderPlan.intentId}.mp4`,
          sizeBytes: BigInt(outputStat.size),
          sha256,
          ...(receipt.etag ? { etag: receipt.etag } : {}),
          ...(receipt.version ? { storageVersion: receipt.version } : {}),
          ...rendered,
        });
        finalized = true;
        succeeded = true;
        return;
      }

      cachedSource = await this.sourceCache.acquire({
        identity: {
          sourceId:
            job.type === "MONTAGE_ASSET_PROBE"
              ? job.montageAssetId
              : job.sourceId,
          sourceVersion:
            job.type === "MONTAGE_ASSET_PROBE" ? 1 : job.sourceVersion,
          sha256: job.sourceSha256,
          sizeBytes: job.sourceSizeBytes,
        },
        outputReservationBytes:
          job.type === "MONTAGE_ASSET_PROBE" ? 0n : job.sourceSizeBytes,
        safetyBytes: this.limits.scratchSafetyBytes,
        signal: abort.signal,
        fill: (destination, signal) =>
          this.storage.download(
            job.sourceObjectKey,
            destination,
            signal,
            job.type === "MONTAGE_ASSET_PROBE"
              ? job.sourceSizeBytes
              : undefined,
          ),
        onTelemetry: ({ phase, durationMs, outcome, ...details }) =>
          recordPhase(phase, durationMs, outcome, details),
      });
      scratch = await mkdtemp(
        join(this.limits.scratchDirectory, "content-factory-media-"),
      );
      const sourcePath = cachedSource.path;
      if (job.type === "MONTAGE_ASSET_PROBE") {
        const result = await measurePhase("source_probe", () =>
          this.processor.inspectMontage(
            sourcePath,
            AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
          ),
        );
        if (abort.signal.aborted) throw abort.signal.reason;
        await this.assertActiveLease(job);
        await this.repository.completeMontageProbe(job, result);
        succeeded = true;
        return;
      }
      const cachedProbe = await measurePhase(
        "source_probe",
        () =>
          cachedSource!.probe(
            (probeSignal) => this.processor.probe(sourcePath, probeSignal),
            abort.signal,
          ),
        (value) => ({ probeCacheHit: value.hit }),
      );
      const probe = cachedProbe.result;
      if (job.type === "SOURCE_PROBE") {
        await this.repository.completeProbe(
          job,
          probe.durationMs,
          probe.version,
        );
        succeeded = true;
        return;
      }
      if (!job.segment)
        throw new ControlledMediaError(
          "CUT_SEGMENT_MISSING",
          "Не удалось прочитать границы отрезка.",
          false,
        );
      if (job.segment.endMs > probe.durationMs) {
        throw new ControlledMediaError(
          "CUT_BOUNDS_INVALID",
          "Конец отрезка выходит за длительность исходного видео.",
          false,
        );
      }
      const outputPath = join(scratch, "result.mp4");
      const cut = await measurePhase("encode", () =>
        this.processor.cut({
          recipeVersion: job.recipeVersion,
          sourcePath,
          outputPath,
          startMs: job.segment!.startMs,
          endMs: job.segment!.endMs,
          signal: abort.signal,
          onProgress: (value) => {
            lastProgress = Math.min(
              value,
              job.segment!.endMs - job.segment!.startMs,
            );
          },
        }),
      );
      const expectedDurationMs = job.segment.endMs - job.segment.startMs;
      await measurePhase("output_probe", async () => {
        const outputProbe = await this.processor.inspectOutput(
          outputPath,
          abort.signal,
        );
        assertValidCutOutput(outputProbe, expectedDurationMs);
        return outputProbe;
      });
      const outputStat = await stat(outputPath);
      const sha256 = await measurePhase(
        "output_hash",
        () => hashFile(outputPath, abort.signal),
        () => ({ bytes: outputStat.size.toString() }),
      );
      await this.assertActiveLease(job);
      const objectKey = `sources/${job.projectId}/results/${job.id}/attempt-${job.attemptNumber}-${safeIdentity(job.leaseToken)}.mp4`;
      const filename = `${safeBaseName(job.originalFilename)}-${job.segment.startMs}-${job.segment.endMs}.mp4`;
      await this.repository.prepareAttemptOutput(job, objectKey);
      uploadedObjectKey = objectKey;
      const receipt = await measurePhase(
        "upload",
        () =>
          this.storage.upload({
            objectKey,
            filePath: outputPath,
            sha256,
            signal: abort.signal,
          }),
        () => ({ bytes: outputStat.size.toString() }),
      );
      await this.assertActiveLease(job);
      await this.repository.completeCut(job, {
        objectKey,
        filename,
        sizeBytes: BigInt(outputStat.size),
        sha256,
        ...(receipt.etag ? { etag: receipt.etag } : {}),
        ...(receipt.version ? { storageVersion: receipt.version } : {}),
        ffmpegVersion: cut.version,
      });
      finalized = true;
      succeeded = true;
    } catch (error) {
      let failure = error;
      if (uploadedObjectKey && !finalized) {
        if (job.type === "ASSEMBLE_HORIZONTAL") {
          try {
            if (
              await this.repository.isAssemblyResultAccepted(
                job,
                uploadedObjectKey,
              )
            ) {
              finalized = true;
              succeeded = true;
              uploadedObjectKey = undefined;
              return;
            }
          } catch {
            // The accepted result must be reread before deletion. A durable
            // cleanup intent already exists, so reconciliation can decide
            // after PostgreSQL becomes reachable again.
            uploadedObjectKey = undefined;
            failure = new ControlledMediaError(
              "ASSEMBLY_FINALIZE_OUTCOME_UNKNOWN",
              "Не удалось подтвердить результат сборки после завершения записи.",
              true,
            );
          }
        }
        try {
          if (!uploadedObjectKey) throw failure;
          await this.storage.delete(uploadedObjectKey);
          await this.repository.completeAttemptCleanup(job, uploadedObjectKey);
        } catch {
          if (uploadedObjectKey) {
            failure = new ControlledMediaError(
              "ORPHAN_CLEANUP_FAILED",
              "Не удалось удалить непринятый результат обработки.",
              true,
            );
          }
        }
        uploadedObjectKey = undefined;
      }
      const controlled = normalizeError(failure, abort.signal);
      failureCode = controlled.code;
      const disposition = await this.repository.fail(
        job,
        controlled.code,
        controlled.safeMessage,
        controlled.retryable,
      );
      if (disposition !== "FAILED_FINAL") throw controlled;
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      clearTimeout(timeout);
      try {
        await releaseAttemptResources(
          () => cachedSource?.release() ?? Promise.resolve(),
          () =>
            scratch
              ? rm(scratch, { recursive: true, force: true })
              : Promise.resolve(),
          () => {
            this.reservedScratchBytes -= scratchReservation;
          },
        );
      } finally {
        recordPhase(
          "total",
          elapsed(totalStartedAt),
          succeeded ? "success" : abort.signal.aborted ? "aborted" : "failure",
          {
            ...(failureCode ? { failureCode } : {}),
            ...(scratchReservation > 0n
              ? { scratchReservationBytes: scratchReservation.toString() }
              : {}),
          },
        );
      }
    }
  }

  private async assertActiveLease(job: ClaimedMediaJob): Promise<void> {
    if (!(await this.repository.isLeaseActive(job))) throw leaseLostError();
  }

  private async updateAssemblyProgress(
    job: ClaimedMediaJob,
    phase:
      | "DOWNLOAD"
      | "AUDIO_ANALYSIS"
      | "ENCODE"
      | "OUTPUT_PROBE"
      | "OUTPUT_HASH"
      | "UPLOAD"
      | "FINALIZE",
    basisPoints: number,
  ): Promise<void> {
    if (
      !(await this.repository.updateAssemblyProgress(job, phase, basisPoints))
    ) {
      throw leaseLostError();
    }
  }
}

export async function releaseAttemptResources(
  releaseCachedSource: () => Promise<void>,
  removeScratch: () => Promise<void>,
  releaseScratchReservation: () => void,
): Promise<void> {
  let cleanupFailure: unknown;
  try {
    await releaseCachedSource();
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    await removeScratch();
  } catch (error) {
    cleanupFailure ??= error;
  } finally {
    releaseScratchReservation();
  }
  if (cleanupFailure) throw cleanupFailure;
}

async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (signal.aborted) throw signal.reason;
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function safeBaseName(filename: string): string {
  return (
    filename
      .replace(/\.mp4$/i, "")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 80) || "cut"
  );
}

function normalizeError(
  error: unknown,
  signal: AbortSignal,
): ControlledMediaError {
  if (error instanceof ControlledMediaError) return error;
  if (signal.aborted && signal.reason instanceof ControlledMediaError) {
    return signal.reason;
  }
  if (error instanceof Error && error.message === "JOB_LEASE_LOST") {
    return leaseLostError();
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "MEDIA_JOB_TIMEOUT")
  ) {
    return new ControlledMediaError(
      "MEDIA_JOB_TIMEOUT",
      "Обработка превысила допустимое время.",
      true,
    );
  }
  return new ControlledMediaError(
    "MEDIA_PROCESSING_FAILED",
    "Временная ошибка обработки. Задание будет повторено в пределах лимита попыток.",
    true,
  );
}

function assertValidCutOutput(
  output: { durationMs: number; hasVideo: boolean; frameRate?: number },
  expectedDurationMs: number,
): void {
  const twoFramesMs =
    output.frameRate &&
    Number.isFinite(output.frameRate) &&
    output.frameRate > 0
      ? Math.ceil(2_000 / output.frameRate)
      : 0;
  // 250 ms is the documented practical fallback when ffprobe cannot expose FPS.
  const toleranceMs = Math.max(250, twoFramesMs);
  if (
    !output.hasVideo ||
    !Number.isFinite(output.durationMs) ||
    output.durationMs <= 0 ||
    Math.abs(output.durationMs - expectedDurationMs) > toleranceMs
  ) {
    throw new ControlledMediaError(
      "CUT_OUTPUT_INVALID",
      "Созданный MP4 не прошёл проверку длительности и видеопотока.",
      false,
    );
  }
}

function safeIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function telemetryOutcome(
  error: unknown,
  signal: AbortSignal,
): TelemetryOutcome {
  if (
    signal.aborted ||
    (error instanceof ControlledMediaError &&
      (error.code === "JOB_LEASE_LOST" ||
        error.code === "MEDIA_JOB_TIMEOUT")) ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "aborted";
  }
  return "failure";
}

function phaseFailureCode(error: unknown, signal: AbortSignal): string {
  if (error instanceof ControlledMediaError) return error.code;
  if (signal.aborted && signal.reason instanceof ControlledMediaError)
    return signal.reason.code;
  if (error instanceof Error && error.message === "JOB_LEASE_LOST")
    return "JOB_LEASE_LOST";
  return "MEDIA_PROCESSING_FAILED";
}
