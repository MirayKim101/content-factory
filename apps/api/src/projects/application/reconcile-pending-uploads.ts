import { Inject, Injectable, Logger } from "@nestjs/common";

import { OBJECT_STORAGE, type ObjectStorage } from "./object-storage.port.js";
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from "./project-repository.port.js";
import { safeCause } from "./safe-cause.js";

@Injectable()
export class ReconcilePendingUploads {
  private readonly logger = new Logger(ReconcilePendingUploads.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async execute(
    before: Date,
    limit: number,
    signal: AbortSignal,
  ): Promise<number> {
    this.throwIfAborted(signal);
    const pending = await this.projects.findStalePending(before, limit);
    let reconciled = 0;
    for (const upload of pending) {
      this.throwIfAborted(signal);
      const object = await this.storage.headObject(upload.objectKey, signal);
      this.throwIfAborted(signal);
      if (
        object &&
        object.sizeBytes === Number(upload.expectedSizeBytes) &&
        object.sha256 === upload.expectedSha256
      ) {
        await this.projects.finalizeReady(upload.artifactId, object);
      } else {
        const mismatch = object !== null;
        await this.projects.markFailed(
          upload.projectId,
          mismatch
            ? "SOURCE_OBJECT_INTEGRITY_MISMATCH"
            : "SOURCE_OBJECT_MISSING_AFTER_RESTART",
          mismatch
            ? "Source object failed integrity verification during recovery."
            : "Source object was not found during recovery.",
          mismatch,
        );
      }
      reconciled += 1;
    }

    this.throwIfAborted(signal);
    const cleanup = await this.projects.findPendingCleanup(limit);
    for (const item of cleanup) {
      this.throwIfAborted(signal);
      try {
        await this.storage.deleteObject(item.objectKey, signal);
        this.throwIfAborted(signal);
        await this.projects.markCleanupCompleted(item.artifactId);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        await this.projects.recordCleanupFailure(
          item.artifactId,
          "OBJECT_DELETE_FAILED",
        );
        this.logger.error({
          event: "source_cleanup_retry_failed",
          code: "OBJECT_DELETE_FAILED",
          projectId: item.projectId,
          artifactId: item.artifactId,
          cause: safeCause(error),
        });
      }
    }
    return reconciled;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("SOURCE_PENDING_RECONCILIATION_TIMEOUT");
    }
  }
}
