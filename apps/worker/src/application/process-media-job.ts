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
  MediaJobRepository,
  MediaProcessor,
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
    private readonly workerId: string,
    private readonly limits: MediaWorkerLimits,
  ) {}

  async execute(jobId: string): Promise<void> {
    const job = await this.repository.claim(
      jobId,
      this.workerId,
      this.limits.leaseMs,
    );
    if (!job) return;
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
      this.limits.jobTimeoutMs,
    );
    timeout.unref();
    let scratch: string | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatRunning = false;
    let heartbeatStopped = false;
    let lastProgress = -1;
    let uploadedObjectKey: string | undefined;
    let finalized = false;

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
      await heartbeat();
      if (abort.signal.aborted) throw abort.signal.reason;
      heartbeatTimer = setInterval(
        () => void heartbeat(),
        Math.max(1_000, Math.floor(this.limits.leaseMs / 3)),
      );
      heartbeatTimer.unref();

      await this.assertScratchCapacity(job.sourceSizeBytes);
      scratch = await mkdtemp(
        join(this.limits.scratchDirectory, "content-factory-media-"),
      );
      const sourcePath = join(scratch, "source.mp4");
      await this.storage.download(
        job.sourceObjectKey,
        sourcePath,
        abort.signal,
      );
      const probe = await this.processor.probe(sourcePath, abort.signal);
      if (job.type === "SOURCE_PROBE") {
        await this.repository.completeProbe(
          job,
          probe.durationMs,
          probe.version,
        );
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
      const cut = await this.processor.cut({
        sourcePath,
        outputPath,
        startMs: job.segment.startMs,
        endMs: job.segment.endMs,
        signal: abort.signal,
        onProgress: (value) => {
          lastProgress = Math.min(
            value,
            job.segment!.endMs - job.segment!.startMs,
          );
        },
      });
      const expectedDurationMs = job.segment.endMs - job.segment.startMs;
      const outputProbe = await this.processor.inspectOutput(
        outputPath,
        abort.signal,
      );
      assertValidCutOutput(outputProbe, expectedDurationMs);
      const outputStat = await stat(outputPath);
      const sha256 = await hashFile(outputPath);
      await this.assertActiveLease(job);
      const objectKey = `sources/${job.projectId}/results/${job.id}/attempt-${job.attemptNumber}-${safeIdentity(job.leaseToken)}.mp4`;
      const filename = `${safeBaseName(job.originalFilename)}-${job.segment.startMs}-${job.segment.endMs}.mp4`;
      await this.repository.prepareAttemptOutput(job, objectKey);
      uploadedObjectKey = objectKey;
      const receipt = await this.storage.upload({
        objectKey,
        filePath: outputPath,
        sha256,
        signal: abort.signal,
      });
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
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  private async assertActiveLease(job: ClaimedMediaJob): Promise<void> {
    if (!(await this.repository.isLeaseActive(job))) throw leaseLostError();
  }

  private async assertScratchCapacity(sourceBytes: bigint): Promise<void> {
    const stats = await statfs(this.limits.scratchDirectory);
    const available = BigInt(stats.bavail) * BigInt(stats.bsize);
    const required = sourceBytes * 2n + this.limits.scratchSafetyBytes;
    if (available < required) {
      throw new ControlledMediaError(
        "SCRATCH_ADMISSION_DENIED",
        "Недостаточно временного дискового пространства для обработки.",
        true,
      );
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
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
