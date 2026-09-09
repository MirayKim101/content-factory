import { Inject, Injectable, Logger } from "@nestjs/common";

import { safeCause } from "../../projects/application/safe-cause.js";
import {
  CREATOR_CONTEXT_REPOSITORY,
  type CreatorContextRepository,
} from "./creator-context-repository.port.js";
import {
  CREATOR_CONTEXT_STORAGE,
  type CreatorContextStorage,
} from "./creator-context-storage.port.js";

@Injectable()
export class ReconcileCreatorReferences {
  private readonly logger = new Logger(ReconcileCreatorReferences.name);

  constructor(
    @Inject(CREATOR_CONTEXT_REPOSITORY)
    private readonly repository: CreatorContextRepository,
    @Inject(CREATOR_CONTEXT_STORAGE)
    private readonly storage: CreatorContextStorage,
  ) {}

  async execute(input: { staleBefore: Date; limit: number }): Promise<void> {
    const rows = await this.repository.listRecoverableReferences(input);
    for (const row of rows) {
      if (row.status === "FAILED_FINAL") {
        await this.cleanup(row.id, row.objectKey);
        continue;
      }
      try {
        const object = await this.storage.headObject(row.objectKey);
        if (
          object &&
          object.sizeBytes === Number(row.sizeBytes) &&
          object.sha256 === row.sha256
        ) {
          await this.repository.finalizeReference(row.id, {
            etag: object.etag,
            version: object.version,
          });
          continue;
        }
        await this.repository.failReference(
          row.id,
          "CREATOR_REFERENCE_RECOVERY_FAILED",
        );
        await this.cleanup(row.id, row.objectKey);
      } catch (error) {
        this.logger.error({
          event: "creator_reference_recovery_failed",
          assetId: row.id,
          cause: safeCause(error),
        });
      }
    }
  }

  private async cleanup(assetId: string, objectKey: string): Promise<void> {
    try {
      await this.storage.deleteObject(objectKey);
      await this.repository.completeReferenceCleanup(assetId);
    } catch (error) {
      await this.repository
        .recordReferenceCleanupFailure(assetId, "OBJECT_DELETE_FAILED")
        .catch(() => undefined);
      this.logger.error({
        event: "creator_reference_cleanup_retry_failed",
        assetId,
        cause: safeCause(error),
      });
    }
  }
}
