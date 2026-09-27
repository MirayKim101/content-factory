import { Inject, Injectable, Logger } from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { safeCause } from "../../projects/application/safe-cause.js";
import {
  EDITORIAL_REPOSITORY,
  type EditorialRepository,
} from "./editorial-repository.port.js";
import {
  EDITORIAL_STORAGE,
  type EditorialStorage,
} from "./editorial-storage.port.js";

@Injectable()
export class ReconcileEditorialAssets {
  private readonly logger = new Logger(ReconcileEditorialAssets.name);

  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
    @Inject(EDITORIAL_STORAGE) private readonly storage: EditorialStorage,
  ) {}

  async execute(signal?: AbortSignal): Promise<void> {
    const config = apiEnvironment();
    this.throwIfAborted(signal);
    const candidates = await this.repository.listRecoverableAssets({
      staleBefore: new Date(Date.now() - config.reconcileStaleAfterMs),
      limit: config.reconcileLimit,
    });
    for (const candidate of candidates) {
      this.throwIfAborted(signal);
      if (
        candidate.status === "FAILED_FINAL" &&
        candidate.cleanupStatus === "PENDING"
      ) {
        await this.cleanup(candidate.id, candidate.objectKey, signal);
        continue;
      }
      if (candidate.status !== "PENDING") continue;
      try {
        const stored = await this.storage.headObject(
          candidate.objectKey,
          signal,
        );
        this.throwIfAborted(signal);
        if (
          stored &&
          stored.sizeBytes === Number(candidate.sizeBytes) &&
          stored.sha256 === candidate.sha256
        ) {
          await this.repository.finalizeAsset(candidate.id, stored);
          continue;
        }
        await this.repository.failAsset(
          candidate.id,
          "THUMBNAIL_RECOVERY_FAILED",
          "Thumbnail upload could not be recovered.",
        );
        await this.cleanup(candidate.id, candidate.objectKey, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        this.logger.error({
          event: "thumbnail_recovery_failed",
          code: "THUMBNAIL_RECOVERY_FAILED",
          assetId: candidate.id,
          cause: safeCause(error),
        });
      }
    }
  }

  private async cleanup(
    assetId: string,
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.storage.deleteObject(objectKey, signal);
      this.throwIfAborted(signal);
      await this.repository.completeAssetCleanup(assetId);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      try {
        await this.repository.recordAssetCleanupFailure(
          assetId,
          "OBJECT_DELETE_FAILED",
        );
      } catch (persistenceError) {
        this.logger.error({
          event: "thumbnail_cleanup_failure_persistence_failed",
          code: "OBJECT_DELETE_FAILED",
          assetId,
          cause: safeCause(persistenceError),
        });
      }
      this.logger.error({
        event: "thumbnail_cleanup_retry_failed",
        code: "OBJECT_DELETE_FAILED",
        assetId,
        cause: safeCause(error),
      });
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("EDITORIAL_RECONCILIATION_ABORTED");
  }
}
