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

  async execute(): Promise<void> {
    const config = apiEnvironment();
    const candidates = await this.repository.listRecoverableAssets({
      staleBefore: new Date(Date.now() - config.reconcileStaleAfterMs),
      limit: config.reconcileLimit,
    });
    for (const candidate of candidates) {
      if (
        candidate.status === "FAILED_FINAL" &&
        candidate.cleanupStatus === "PENDING"
      ) {
        await this.cleanup(candidate.id, candidate.objectKey);
        continue;
      }
      if (candidate.status !== "PENDING") continue;
      try {
        const stored = await this.storage.headObject(candidate.objectKey);
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
        await this.cleanup(candidate.id, candidate.objectKey);
      } catch (error) {
        this.logger.error({
          event: "thumbnail_recovery_failed",
          code: "THUMBNAIL_RECOVERY_FAILED",
          assetId: candidate.id,
          cause: safeCause(error),
        });
      }
    }
  }

  private async cleanup(assetId: string, objectKey: string): Promise<void> {
    try {
      await this.storage.deleteObject(objectKey);
      await this.repository.completeAssetCleanup(assetId);
    } catch (error) {
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
}
