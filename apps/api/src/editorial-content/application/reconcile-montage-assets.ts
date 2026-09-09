import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../../projects/application/object-storage.port.js";
import {
  MONTAGE_REPOSITORY,
  type MontageRepository,
} from "./montage-repository.port.js";

@Injectable()
export class ReconcileMontageAssets {
  private readonly logger = new Logger(ReconcileMontageAssets.name);
  constructor(
    @Inject(MONTAGE_REPOSITORY) private readonly repository: MontageRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}
  async execute() {
    for (const asset of await this.repository.recoverable(25)) {
      try {
        if (asset.status === "UPLOADING") {
          const receipt = await this.storage.headObject(
            asset.objectKey,
            AbortSignal.timeout(10_000),
          );
          if (
            receipt &&
            receipt.sha256 === asset.sha256 &&
            BigInt(receipt.sizeBytes ?? -1) === asset.sizeBytes
          ) {
            await this.repository.finalize(asset.id, receipt);
            continue;
          }
          if (
            !(await this.repository.failUpload(
              asset.id,
              "MONTAGE_UPLOAD_INCOMPLETE",
            ))
          )
            continue;
        }
        // Only an expired upload or terminal probe can schedule cleanup; READY is never deleted.
        const current = await this.repository.inspect(asset.id);
        if (
          current?.status !== "FAILED_FINAL" ||
          current.cleanupStatus !== "PENDING"
        )
          continue;
        try {
          await this.storage.deleteObject(
            asset.objectKey,
            AbortSignal.timeout(10_000),
          );
          await this.repository.completeCleanup(asset.id);
        } catch {
          await this.repository.cleanupFailed(asset.id);
        }
      } catch {
        this.logger.error({
          event: "montage_recovery_retryable",
          assetId: asset.id,
          code: "MONTAGE_RECOVERY_RETRYABLE",
        });
      }
    }
  }
}
