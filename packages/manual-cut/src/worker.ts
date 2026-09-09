import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { CUT_RECIPE_VERSION } from "./domain.js";
import type {
  ActiveLease,
  Clock,
  CutJobRepository,
  MediaRuntime,
  ScratchCapacity,
  WorkerEventSink,
  WorkerObjectStorage,
} from "./ports.js";

export interface ManualCutWorkerConfig {
  scratchRoot: string;
  leaseMs: number;
  heartbeatMs: number;
  heavyConcurrency: number;
  scratchSafetyBytes: bigint;
  outputBitsPerSecond: bigint;
  scratchCapacityBytes: bigint;
  cleanupTimeoutMs: number;
}

export class ManualCutWorker {
  constructor(
    private readonly jobs: CutJobRepository,
    private readonly storage: WorkerObjectStorage,
    private readonly runtime: MediaRuntime,
    private readonly capacity: ScratchCapacity,
    private readonly clock: Clock,
    private readonly config: ManualCutWorkerConfig,
    private readonly events: WorkerEventSink = { emit: () => undefined },
  ) {}

  async execute(jobId: string): Promise<"DONE" | "SKIPPED" | "WAITING"> {
    const admission = await this.jobs.getAdmission(jobId);
    if (!admission) return "SKIPPED";
    const predictedOutput =
      (BigInt(admission.requestedDurationMs) * this.config.outputBitsPerSecond +
        7_999n) /
      8_000n;
    const reservation =
      admission.sourceSizeBytes +
      predictedOutput +
      this.config.scratchSafetyBytes;
    const capacity = await this.capacity.inspect(reservation);
    if (capacity.outcome === "IMPOSSIBLE") {
      await this.jobs.failWithoutAttempt(
        jobId,
        "SCRATCH_CAPACITY_EXCEEDED",
        "The source and predicted output exceed usable scratch capacity.",
      );
      return "DONE";
    }
    if (capacity.outcome === "TEMPORARY_PRESSURE") {
      const outcome = await this.jobs.markScratchWait(jobId, this.clock.now());
      return outcome === "WAITING" ? "WAITING" : "DONE";
    }

    const claimed = await this.jobs.claim({
      jobId,
      attemptId: randomUUID(),
      leaseToken: randomUUID(),
      now: this.clock.now(),
      leaseMs: this.config.leaseMs,
      reservedScratchBytes: reservation,
      scratchCapacityBytes:
        capacity.usableBytes < this.config.scratchCapacityBytes
          ? capacity.usableBytes
          : this.config.scratchCapacityBytes,
      heavyConcurrency: this.config.heavyConcurrency,
    });
    if (claimed.outcome === "NO_CAPACITY") {
      const outcome = await this.jobs.markScratchWait(jobId, this.clock.now());
      return outcome === "WAITING" ? "WAITING" : "DONE";
    }
    if (claimed.outcome !== "CLAIMED") return "SKIPPED";

    const { claim } = claimed;
    this.emit({
      name: "cut_claimed",
      jobId,
      attemptNumber: claim.attemptNumber,
    });
    const lease: ActiveLease = {
      jobId,
      attemptId: claim.attemptId,
      leaseToken: claim.leaseToken,
      claimRevision: claim.claimRevision,
    };
    const abort = new AbortController();
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || abort.signal.aborted) return;
      heartbeatBusy = true;
      void this.jobs
        .heartbeat(lease, this.clock.now(), this.config.leaseMs)
        .then((active) => {
          if (!active) abort.abort(new LeaseLostError());
        })
        .catch(() => abort.abort(new LeaseLostError()))
        .finally(() => {
          heartbeatBusy = false;
        });
    }, this.config.heartbeatMs);
    heartbeat.unref();

    const attemptDirectory = join(this.config.scratchRoot, claim.attemptId);
    const sourcePath = join(attemptDirectory, "source.mp4");
    const outputPath = join(attemptDirectory, "output.mp4");
    let outputObjectKey: string | null = null;
    let progressQueue = Promise.resolve();
    let progressStage = -1;
    let progressCurrent = 0n;
    const queueProgress = (
      stage: string,
      current: bigint,
      total: bigint,
      unit: "BYTES" | "MILLISECONDS",
    ): void => {
      const rank =
        { SOURCE_DOWNLOAD: 1, ENCODING: 2, OUTPUT_UPLOAD: 3 }[stage] ?? 0;
      if (rank < progressStage) return;
      if (rank > progressStage) {
        progressStage = rank;
        progressCurrent = 0n;
      }
      progressCurrent = current > progressCurrent ? current : progressCurrent;
      const monotonicCurrent = progressCurrent;
      progressQueue = progressQueue.then(() =>
        this.progressOrAbort(
          lease,
          abort,
          stage,
          monotonicCurrent,
          total,
          unit,
        ),
      );
    };
    try {
      await mkdir(attemptDirectory, { recursive: true });
      try {
        await this.storage.downloadToFile({
          objectKey: claim.source.objectKey,
          filePath: sourcePath,
          signal: abort.signal,
          onProgress: ({ current, total }) => {
            queueProgress("SOURCE_DOWNLOAD", current, total, "BYTES");
          },
        });
      } catch (error) {
        if (abort.signal.aborted) throw abort.signal.reason ?? error;
        throw new RetryableStorageError();
      }
      await progressQueue;
      this.throwIfAborted(abort.signal);
      const sourceSha256 = await hashFile(sourcePath, abort.signal);
      if (sourceSha256 !== claim.job.sourceSha256)
        throw new FinalMediaError(
          "INVALID_SOURCE_MEDIA",
          "The stored source failed its integrity check.",
        );
      const sourceProbe = await this.runtime.probe({
        inputPath: sourcePath,
        signal: abort.signal,
      });
      if (
        !sourceProbe.streams.some((stream) => stream.type === "video") ||
        sourceProbe.durationMs <= 0
      )
        throw new FinalMediaError(
          "INVALID_SOURCE_MEDIA",
          "The source is not a valid video.",
        );
      if (claim.job.endMs > sourceProbe.durationMs)
        throw new FinalMediaError(
          "CUT_OUT_OF_BOUNDS",
          "The requested cut exceeds the source duration.",
        );

      let encoded = 0;
      await this.runtime.cut({
        inputPath: sourcePath,
        outputPath,
        startMs: claim.job.startMs,
        endMs: claim.job.endMs,
        recipe: CUT_RECIPE_VERSION,
        signal: abort.signal,
        onProgress: (value) => {
          encoded = Math.max(
            encoded,
            Math.min(value, claim.job.endMs - claim.job.startMs),
          );
          queueProgress(
            "ENCODING",
            BigInt(encoded),
            BigInt(claim.job.endMs - claim.job.startMs),
            "MILLISECONDS",
          );
        },
      });
      await progressQueue;
      this.throwIfAborted(abort.signal);
      const outputProbe = await this.runtime.probe({
        inputPath: outputPath,
        signal: abort.signal,
      });
      const expectedDuration = claim.job.endMs - claim.job.startMs;
      if (
        !outputProbe.streams.some((stream) => stream.type === "video") ||
        Math.abs(outputProbe.durationMs - expectedDuration) > 100
      )
        throw new RetryableMediaError(
          "OUTPUT_VALIDATION_FAILED",
          "The encoded output did not pass validation.",
        );
      const outputStat = await stat(outputPath);
      const sha256 = await hashFile(outputPath, abort.signal);
      outputObjectKey = `projects/${claim.job.projectId}/cuts/${claim.job.id}/attempts/${claim.attemptNumber}-${claim.attemptId}.mp4`;
      if (
        !(await this.jobs.persistOutputIntent(
          lease,
          outputObjectKey,
          this.clock.now(),
        ))
      )
        throw new LeaseLostError();
      let receipt: { etag?: string; version?: string };
      try {
        receipt = await this.storage.putFile({
          objectKey: outputObjectKey,
          filePath: outputPath,
          contentType: "video/mp4",
          sha256,
          signal: abort.signal,
          onProgress: ({ current, total }) => {
            queueProgress("OUTPUT_UPLOAD", current, total, "BYTES");
          },
        });
      } catch (error) {
        if (abort.signal.aborted) throw abort.signal.reason ?? error;
        throw new RetryableStorageError();
      }
      await progressQueue;
      this.throwIfAborted(abort.signal);
      const completed = await this.jobs.complete(
        lease,
        {
          id: randomUUID(),
          objectKey: outputObjectKey,
          sizeBytes: BigInt(outputStat.size),
          sha256,
          contentType: "video/mp4",
          ...(receipt.etag ? { storageEtag: receipt.etag } : {}),
          ...(receipt.version ? { storageVersion: receipt.version } : {}),
        },
        this.clock.now(),
      );
      if (!completed) throw new LeaseLostError();
      outputObjectKey = null;
      this.emit({
        name: "cut_succeeded",
        jobId,
        attemptNumber: claim.attemptNumber,
      });
      return "DONE";
    } catch (error) {
      abort.abort(error);
      if (error instanceof LeaseLostError) {
        this.emit({
          name: "cut_lease_lost",
          jobId,
          attemptNumber: claim.attemptNumber,
        });
      } else {
        const classified = classifyError(error);
        this.emit({
          name: "cut_attempt_failed",
          jobId,
          attemptNumber: claim.attemptNumber,
          safeCode: classified.code,
          retryable: classified.retryable,
        });
        await this.jobs.fail(lease, {
          ...classified,
          now: this.clock.now(),
          retryDelayMs: Math.min(
            60_000,
            1_000 * 2 ** Math.max(0, claim.attemptNumber - 1),
          ),
        });
      }
      if (outputObjectKey)
        await this.cleanupAttemptOutput(
          claim.attemptId,
          outputObjectKey,
          jobId,
          claim.attemptNumber,
        );
      return "DONE";
    } finally {
      clearInterval(heartbeat);
      await rm(attemptDirectory, { recursive: true, force: true });
    }
  }

  async reconcile(): Promise<number> {
    const now = this.clock.now();
    await mkdir(this.config.scratchRoot, { recursive: true });
    const recovered = await this.jobs.reconcileExpired(now);
    for (const jobId of recovered)
      this.emit({ name: "cut_lease_reconciled", jobId });
    const candidateIds = (
      await readdir(this.config.scratchRoot, { withFileTypes: true })
    )
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            entry.name,
          ),
      )
      .map((entry) => entry.name);
    for (let offset = 0; offset < candidateIds.length; offset += 100) {
      const scratchCleanupIds = await this.jobs.findScratchCleanupAttemptIds(
        candidateIds.slice(offset, offset + 100),
      );
      for (const attemptId of scratchCleanupIds)
        await rm(join(this.config.scratchRoot, attemptId), {
          recursive: true,
          force: true,
        });
    }
    const pending = await this.jobs.findPendingOutputCleanup(100);
    for (const cleanup of pending)
      await this.cleanupAttemptOutput(
        cleanup.attemptId,
        cleanup.objectKey,
        cleanup.jobId,
        cleanup.attemptNumber,
      );
    return pending.length;
  }

  private async progressOrAbort(
    lease: ActiveLease,
    controller: AbortController,
    stage: string,
    current: bigint,
    total: bigint,
    unit: "BYTES" | "MILLISECONDS",
  ): Promise<void> {
    if (total <= 0n || controller.signal.aborted) return;
    try {
      const active = await this.jobs.recordProgress(
        lease,
        stage,
        current,
        total,
        unit,
        this.clock.now(),
      );
      if (!active) controller.abort(new LeaseLostError());
    } catch {
      controller.abort(new LeaseLostError());
    }
  }

  private async cleanupAttemptOutput(
    attemptId: string,
    objectKey: string,
    jobId?: string,
    attemptNumber?: number,
  ): Promise<void> {
    try {
      const signal = AbortSignal.timeout(this.config.cleanupTimeoutMs);
      if (await this.storage.headObject(objectKey, signal))
        await this.storage.deleteObject(objectKey, signal);
      await this.jobs.completeOutputCleanup(attemptId, this.clock.now());
      this.emit({
        name: "cut_output_cleanup_completed",
        ...(jobId ? { jobId } : {}),
        ...(attemptNumber ? { attemptNumber } : {}),
      });
    } catch {
      await this.jobs.failOutputCleanup(attemptId, "STORAGE_CLEANUP_FAILED");
      this.emit({
        name: "cut_output_cleanup_failed",
        ...(jobId ? { jobId } : {}),
        ...(attemptNumber ? { attemptNumber } : {}),
        safeCode: "STORAGE_CLEANUP_FAILED",
        retryable: true,
      });
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted)
      throw signal.reason instanceof Error
        ? signal.reason
        : new LeaseLostError();
  }

  private emit(event: Parameters<WorkerEventSink["emit"]>[0]): void {
    try {
      this.events.emit(event);
    } catch {
      // Telemetry is best-effort and never owns job or artifact state.
    }
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super("LEASE_LOST");
  }
}

export class FinalMediaError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(code);
  }
}

export class RetryableMediaError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(code);
  }
}

export class RetryableStorageError extends Error {
  constructor() {
    super("STORAGE_OPERATION_FAILED");
  }
}

function classifyError(error: unknown): {
  retryable: boolean;
  code: string;
  message: string;
} {
  if (error instanceof FinalMediaError)
    return { retryable: false, code: error.code, message: error.safeMessage };
  if (error instanceof RetryableMediaError)
    return { retryable: true, code: error.code, message: error.safeMessage };
  if (error instanceof RetryableStorageError)
    return {
      retryable: true,
      code: "STORAGE_OPERATION_FAILED",
      message: "Object storage was temporarily unavailable.",
    };
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    return {
      retryable: true,
      code: "MEDIA_TIMEOUT",
      message: "Media processing timed out or was interrupted.",
    };
  return {
    retryable: true,
    code: "MEDIA_PROCESSING_FAILED",
    message: "Media processing failed and may be retried.",
  };
}

async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
