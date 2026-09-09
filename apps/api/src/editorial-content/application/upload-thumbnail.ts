import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rm } from "node:fs/promises";
import { basename } from "node:path";

import { Inject, Injectable, Logger } from "@nestjs/common";

import {
  EDITORIAL_REPOSITORY,
  EditorialIdempotencyConflictError,
  type EditorialRepository,
} from "./editorial-repository.port.js";
import {
  EDITORIAL_STORAGE,
  type EditorialStorage,
} from "./editorial-storage.port.js";
import {
  inspectThumbnail,
  THUMBNAIL_MAX_BYTES,
  type EditorialAssetView,
} from "../domain/editorial.js";
import { safeCause } from "../../projects/application/safe-cause.js";

export class EditorialUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

@Injectable()
export class UploadThumbnail {
  private readonly logger = new Logger(UploadThumbnail.name);

  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
    @Inject(EDITORIAL_STORAGE) private readonly storage: EditorialStorage,
  ) {}

  async execute(input: {
    projectId: string;
    idempotencyKey: string;
    originalFilename: string;
    declaredContentType: string;
    filePath: string;
  }): Promise<EditorialAssetView> {
    try {
      await chmod(input.filePath, 0o600);
      const bytes = await readFile(input.filePath);
      if (bytes.length === 0 || bytes.length > THUMBNAIL_MAX_BYTES) {
        throw new EditorialUploadError(
          "THUMBNAIL_SIZE_INVALID",
          `Thumbnail must be between 1 byte and ${THUMBNAIL_MAX_BYTES} bytes.`,
          413,
        );
      }
      const inspected = inspectThumbnail(bytes, input.declaredContentType);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const originalFilename = basename(
        input.originalFilename.replaceAll("\\", "/"),
      );
      const requestFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            projectId: input.projectId,
            originalFilename,
            sha256,
            sizeBytes: bytes.length,
            contentType: inspected.contentType,
            width: inspected.width,
            height: inspected.height,
          }),
        )
        .digest("hex");
      const existing = await this.repository.findAssetByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new EditorialIdempotencyConflictError();
        }
        return existing.asset;
      }

      const id = randomUUID();
      const objectKey = `editorial/${input.projectId}/thumbnails/${id}/original`;
      try {
        await this.repository.createPendingAsset({
          id,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          objectKey,
          originalFilename,
          contentType: inspected.contentType,
          sizeBytes: BigInt(bytes.length),
          sha256,
          width: inspected.width,
          height: inspected.height,
        });
      } catch (error) {
        if (!(error instanceof EditorialIdempotencyConflictError)) throw error;
        const concurrent = await this.repository.findAssetByIdempotencyKey(
          input.idempotencyKey,
        );
        if (
          !concurrent ||
          concurrent.requestFingerprint !== requestFingerprint
        ) {
          throw new EditorialIdempotencyConflictError();
        }
        return concurrent.asset;
      }

      let receipt: { etag?: string; version?: string };
      try {
        receipt = await this.storage.putFile({
          objectKey,
          filePath: input.filePath,
          contentType: inspected.contentType,
          sha256,
        });
      } catch (error) {
        await this.failAndCleanup(
          id,
          objectKey,
          "THUMBNAIL_STORAGE_FAILED",
          "Thumbnail storage failed.",
          error,
        );
        throw new EditorialUploadError(
          "THUMBNAIL_STORAGE_FAILED",
          "Thumbnail storage failed.",
          503,
        );
      }

      try {
        return await this.repository.finalizeAsset(id, receipt);
      } catch (error) {
        try {
          const authoritative = await this.repository.getAssetFinalization(id);
          if (authoritative?.status === "READY") return authoritative;
        } catch (recoveryError) {
          this.logger.error({
            event: "thumbnail_finalize_outcome_unknown",
            code: "THUMBNAIL_FINALIZE_OUTCOME_UNKNOWN",
            assetId: id,
            cause: safeCause(recoveryError),
          });
          throw new EditorialUploadError(
            "THUMBNAIL_FINALIZE_OUTCOME_UNKNOWN",
            "Thumbnail finalization outcome is being recovered.",
            503,
          );
        }
        await this.failAndCleanup(
          id,
          objectKey,
          "THUMBNAIL_FINALIZE_FAILED",
          "Thumbnail finalization failed.",
          error,
        );
        throw new EditorialUploadError(
          "THUMBNAIL_FINALIZE_FAILED",
          "Thumbnail finalization failed.",
          500,
        );
      }
    } finally {
      await rm(input.filePath, { force: true });
    }
  }

  private async failAndCleanup(
    assetId: string,
    objectKey: string,
    code: string,
    message: string,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.repository.failAsset(assetId, code, message);
    } catch (persistenceError) {
      this.logger.error({
        event: "thumbnail_failure_persistence_failed",
        code,
        assetId,
        cause: safeCause(persistenceError),
      });
      return;
    }
    try {
      await this.storage.deleteObject(objectKey);
      await this.repository.completeAssetCleanup(assetId);
    } catch (cleanupError) {
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
        event: "thumbnail_cleanup_failed",
        code: "OBJECT_DELETE_FAILED",
        assetId,
        cause: safeCause(cleanupError),
      });
    }
    this.logger.error({
      event: "thumbnail_upload_failed",
      code,
      assetId,
      cause: safeCause(cause),
    });
  }
}
