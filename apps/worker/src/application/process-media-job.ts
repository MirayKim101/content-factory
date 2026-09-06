import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  ControlledMediaError,
  leaseLostError,
  type ClaimedMediaJob,
} from "../domain/media-job.js";
import type {
  MediaJobPhaseTelemetry,
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
}

export class ProcessMediaJob {
  constructor(
    private readonly repository: MediaJobRepository,
    private readonly storage: WorkerObjectStorage,
    private readonly processor: MediaProcessor,
    private readonly sourceCache: SourceCache,
    private readonly workerId: string,
    private readonly limits: MediaWorkerLimits,
    private readonly telemetry: MediaJobTelemetry = () => undefined,
  ) {}

  async execute(jobId: string): Promise<void> {
    const job = await this.repository.claim(
      jobId,
      this.workerId,
      this.limits.leaseMs,
    );
    if (!job) return;
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
        !["SOURCE_PROBE", "CUT_SEGMENT", "MONTAGE_ASSET_PROBE"].includes(
          job.type,
        )
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
        try {
          await this.storage.delete(uploadedObjectKey);
          await this.repository.completeAttemptCleanup(job, uploadedObjectKey);
        } catch {
          failure = new ControlledMediaError(
            "ORPHAN_CLEANUP_FAILED",
            "Не удалось удалить непринятый результат обработки.",
            true,
          );
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
      if (cachedSource) await cachedSource.release();
      if (scratch) await rm(scratch, { recursive: true, force: true });
      recordPhase(
        "total",
        elapsed(totalStartedAt),
        succeeded ? "success" : abort.signal.aborted ? "aborted" : "failure",
        failureCode ? { failureCode } : {},
      );
    }
  }

  private async assertActiveLease(job: ClaimedMediaJob): Promise<void> {
    if (!(await this.repository.isLeaseActive(job))) throw leaseLostError();
  }
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
