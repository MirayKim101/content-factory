import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, statfs } from "node:fs/promises";
import { basename, join } from "node:path";
import { FRAME_LIMITS } from "@content-factory/contracts";
import type { FrameExtractor } from "./frame-extractor.port.js";
import type {
  ClaimedFrameWork,
  FrameJobRepository,
} from "./frame-job-repository.port.js";
import type { WorkerObjectStorage } from "./ports.js";
import { ControlledMediaError, leaseLostError } from "../domain/media-job.js";

export interface FrameJobConfiguration {
  scratchDirectory: string;
  scratchSafetyBytes: number;
  leaseMs: number;
  workDeadlineMs: number;
}

/** Sequential owned I/O makes its settlement boundary explicit. No detached
 * upload or child promise may survive executionStopped(). */
export class ProcessFrameJob {
  private localReservedBytes = 0;
  private readonly activeControllers = new Set<AbortController>();
  private reconciliation: Promise<void> | null = null;
  constructor(
    private readonly repository: FrameJobRepository,
    private readonly storage: WorkerObjectStorage,
    private readonly extractor: FrameExtractor,
    private readonly workerId: string,
    private readonly config: FrameJobConfiguration,
    private readonly log: (event: Record<string, unknown>) => void,
  ) {}

  abortAll(): void {
    for (const controller of this.activeControllers)
      controller.abort(leaseLostError());
  }

  async execute(jobId: string): Promise<boolean> {
    const plan = await this.repository.plan(jobId);
    if (!plan) return false;
    await mkdir(this.config.scratchDirectory, { recursive: true, mode: 0o700 });
    const required =
      Number(plan.capture.cutResultSizeBytes) +
      FRAME_LIMITS.maxSetBytes +
      this.config.scratchSafetyBytes;
    const filesystem = await statfs(this.config.scratchDirectory);
    const available =
      filesystem.bavail * filesystem.bsize - this.localReservedBytes;
    // Reserve locally before asynchronous claim; the transaction additionally
    // deducts durable reservations across all worker replicas.
    // Persist the unique name before creating anything on disk. A lost claim
    // response cannot leave unowned scratch; every created directory has a
    // durable attempt discoverable by recovery.
    const directory = join(
      this.config.scratchDirectory,
      `content-factory-frames-${randomUUID()}-${randomBytes(3).toString("hex")}`,
    );
    this.localReservedBytes += required;
    let work: ClaimedFrameWork | null = null;
    try {
      try {
        work = await this.repository.claim({
          plan,
          workerId: this.workerId,
          leaseMs: this.config.leaseMs,
          workDeadlineMs: this.config.workDeadlineMs,
          scratchDirectoryName: basename(directory),
          scratchReservedBytes: required,
          availableScratchBytes: available,
        });
      } catch (error) {
        if (error instanceof ControlledMediaError && !error.retryable) {
          await this.repository.rejectPending(
            plan,
            error.code,
            error.safeMessage,
          );
          return true;
        }
        throw error;
      }
      if (!work) return true;
      await this.perform(work, directory);
    } finally {
      this.localReservedBytes -= required;
      // Claimed scratch is deleted only through persisted inactivity evidence.
      await this.reconcile().catch((error: unknown) =>
        this.log({
          event: "frame_reconciliation_failed",
          code: safeCode(error),
        }),
      );
    }
    return true;
  }

  private async perform(
    work: ClaimedFrameWork,
    directory: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const deadlineDelay = Math.max(
      0,
      work.workDeadlineAt.getTime() - Date.now(),
    );
    const deadlineTimer = setTimeout(
      () =>
        controller.abort(
          new ControlledMediaError(
            "FRAME_WORK_DEADLINE_EXCEEDED",
            "Превышено время обработки кадров.",
            false,
          ),
        ),
      deadlineDelay,
    );
    let heartbeatPromise: Promise<void> | null = null;
    const heartbeat = setInterval(
      () => {
        if (heartbeatPromise) return;
        heartbeatPromise = this.repository
          .heartbeat(work, this.config.leaseMs)
          .then((active) => {
            if (!active) controller.abort(leaseLostError());
          })
          .catch(() => controller.abort(leaseLostError()))
          .finally(() => {
            heartbeatPromise = null;
          });
      },
      Math.max(100, Math.floor(this.config.leaseMs / 3)),
    );
    try {
      await mkdir(directory, { mode: 0o700 });
      await this.repository.admitInputRead(work);
      controller.signal.throwIfAborted();
      const sourcePath = join(directory, "cut.mp4");
      await this.storage.download(
        work.inputObjectKey,
        sourcePath,
        controller.signal,
        BigInt(work.capture.cutResultSizeBytes),
      );
      const inputStat = await stat(sourcePath);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(sourcePath, {
        signal: controller.signal,
      }))
        hash.update(chunk);
      if (
        inputStat.size !== Number(work.capture.cutResultSizeBytes) ||
        hash.digest("hex") !== work.capture.cutResultSha256
      ) {
        throw new ControlledMediaError(
          "FRAME_INPUT_CHECKSUM_MISMATCH",
          "Файл нарезки не прошёл проверку.",
          false,
        );
      }
      await this.repository.progress(work, "READ_INPUT", 0, 2000);
      const frames = await this.extractor.extract({
        sourcePath,
        outputDirectory: directory,
        cutStartMs: work.capture.cutStartMs,
        cutEndMs: work.capture.cutEndMs,
        inputSizeBytes: inputStat.size,
        workDeadlineAt: work.workDeadlineAt,
        signal: controller.signal,
        onMeasuredProgress: async (phase, count) =>
          this.repository.progress(
            work,
            phase,
            count,
            2000 + count * 1500 - (phase === "EXTRACT" ? 250 : 0),
          ),
      });
      for (const frame of frames) {
        controller.signal.throwIfAborted();
        const output = await this.repository.prepareOutput(
          work,
          frame.measurement.ordinal,
        );
        await this.storage.upload({
          objectKey: output.objectKey,
          filePath: frame.filePath,
          sizeBytes: BigInt(frame.measurement.sizeBytes),
          sha256: frame.measurement.sha256,
          contentType: "image/jpeg",
          uploadMode: "SINGLE_REQUEST",
          signal: controller.signal,
        });
        // A successful remote completion is persisted even when the lease was
        // lost meanwhile. Unknown/aborted writes retain cleanup tombstones.
        await this.repository.uploadSettled(work, output);
        controller.signal.throwIfAborted();
        await this.repository.uploaded(work, output, frame.measurement);
        await this.repository.progress(
          work,
          "UPLOAD",
          frame.measurement.ordinal + 1,
          6500 + (frame.measurement.ordinal + 1) * 1000,
        );
      }
      await this.repository.progress(work, "FINALIZE", 3, 9500);
      await this.repository.finalize(work);
      this.log({
        event: "frame_evidence_ready",
        jobId: work.jobId,
        intentId: work.intentId,
        attemptNumber: work.attemptNumber,
      });
    } catch (error) {
      let accepted: boolean | undefined;
      try {
        accepted = await this.repository.accepted(work);
      } catch {
        /* Unknown finalization outcome: leave all exact keys intact. */
      }
      if (accepted === false) {
        const reason = controller.signal.aborted
          ? controller.signal.reason
          : error;
        const controlled =
          reason instanceof ControlledMediaError
            ? reason
            : new ControlledMediaError(
                "FRAME_PROCESSING_FAILED",
                "Не удалось подготовить кадры.",
                true,
              );
        await this.repository
          .fail(
            work,
            controlled.code,
            controlled.safeMessage,
            controlled.retryable,
          )
          .catch(() => undefined);
        this.log({
          event: "frame_evidence_failed",
          jobId: work.jobId,
          attemptNumber: work.attemptNumber,
          code: controlled.code,
          retryable: controlled.retryable,
        });
      } else if (accepted === undefined) {
        this.log({
          event: "frame_finalization_outcome_unknown",
          jobId: work.jobId,
          attemptNumber: work.attemptNumber,
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
      if (heartbeatPromise) await heartbeatPromise;
      this.activeControllers.delete(controller);
      // All awaited input/output and extractor operations have settled here.
      await this.repository.executionStopped(work).catch(() => {
        this.log({
          event: "frame_stop_fence_outcome_unknown",
          jobId: work.jobId,
          attemptNumber: work.attemptNumber,
        });
      });
    }
  }

  async reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.performReconciliation().finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private async performReconciliation(): Promise<void> {
    await this.repository.recover(50);
    for (const candidate of await this.repository.cleanupCandidates(50)) {
      try {
        await this.storage.delete(
          candidate.objectKey,
          AbortSignal.timeout(10_000),
        );
        await this.repository.cleaned(candidate.outputId);
      } catch {
        await this.repository.cleaned(
          candidate.outputId,
          "FRAME_OUTPUT_DELETE_FAILED",
        );
      }
    }
    for (const candidate of await this.repository.scratchCandidates(50)) {
      if (
        !/^content-factory-frames-[0-9a-f-]{36}-[A-Za-z0-9]{6}$/.test(
          candidate.directoryName,
        )
      ) {
        this.log({
          event: "frame_scratch_identity_invalid",
          attemptId: candidate.attemptId,
        });
        continue;
      }
      await rm(join(this.config.scratchDirectory, candidate.directoryName), {
        recursive: true,
        force: true,
      });
      await this.repository.scratchCleaned(
        candidate.attemptId,
        candidate.directoryName,
      );
    }
  }
}

function safeCode(error: unknown): string {
  return error instanceof ControlledMediaError
    ? error.code
    : "FRAME_RECONCILIATION_FAILED";
}
