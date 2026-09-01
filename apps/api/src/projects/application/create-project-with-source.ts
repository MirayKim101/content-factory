import { createHash, randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { basename } from "node:path";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { inspectMp4 } from "./mp4-inspection.js";
import { OBJECT_STORAGE, type ObjectStorage } from "./object-storage.port.js";
import {
  IdempotencyKeyAlreadyExistsError,
  PROJECT_REPOSITORY,
  TerminalStateConflictError,
  type ProjectRepository,
} from "./project-repository.port.js";
import { safeCause } from "./safe-cause.js";
import { UploadError } from "./upload-errors.js";
import type { ProjectView } from "../domain/project.js";

export interface CreateProjectInput {
  name: string;
  originalFilename: string;
  filePath: string;
  idempotencyKey: string;
}

@Injectable()
export class CreateProjectWithSource {
  private readonly logger = new Logger(CreateProjectWithSource.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async execute(input: CreateProjectInput): Promise<ProjectView> {
    try {
      await chmod(input.filePath, 0o600);
      const media = await inspectMp4(input.filePath);
      const normalizedName = input.name.trim();
      const originalFilename = basename(
        input.originalFilename.replaceAll("\\", "/"),
      );
      const requestFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            name: normalizedName,
            originalFilename,
            rightsDeclarationVersion: "upload-rights-v1",
            sha256: media.sha256,
            sizeBytes: media.sizeBytes.toString(),
          }),
        )
        .digest("hex");

      const existing = await this.projects.findByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) return this.resolveIdempotent(existing, requestFingerprint);

      const projectId = randomUUID();
      const sourceId = randomUUID();
      const artifactId = randomUUID();
      const objectKey = `sources/${projectId}/${sourceId}/v1/source.mp4`;

      try {
        await this.projects.createPendingUpload({
          projectId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          sourceId,
          artifactId,
          name: normalizedName,
          rightsConfirmedAt: new Date(),
          rightsDeclarationVersion: "upload-rights-v1",
          originalFilename,
          contentType: media.contentType,
          sizeBytes: media.sizeBytes,
          sha256: media.sha256,
          sourceVersion: 1,
          objectKey,
          recipeVersion: "source-ingest-v1",
        });
      } catch (error) {
        if (!(error instanceof IdempotencyKeyAlreadyExistsError)) throw error;
        const concurrent = await this.projects.findByIdempotencyKey(
          input.idempotencyKey,
        );
        if (!concurrent) throw error;
        return this.resolveIdempotent(concurrent, requestFingerprint);
      }

      let receipt;
      try {
        receipt = await this.storage.putFile({
          objectKey,
          filePath: input.filePath,
          contentType: media.contentType,
          sha256: media.sha256,
        });
      } catch (error) {
        await this.failAndCleanup({
          projectId,
          artifactId,
          objectKey,
          code: "STORAGE_UPLOAD_FAILED",
          message: "Source storage failed.",
          cause: error,
        });
        throw new UploadError(
          "STORAGE_UPLOAD_FAILED",
          "Source storage failed.",
          503,
        );
      }

      try {
        await this.projects.finalizeReady(artifactId, receipt);
      } catch (error) {
        if (error instanceof TerminalStateConflictError) {
          await this.cleanupAfterTerminalConflict({
            projectId,
            artifactId,
            objectKey,
            cause: error,
          });
        } else {
          await this.failAndCleanup({
            projectId,
            artifactId,
            objectKey,
            code: "DATABASE_FINALIZE_FAILED",
            message: "Source finalization failed.",
            cause: error,
          });
        }
        throw new UploadError(
          "DATABASE_FINALIZE_FAILED",
          "Source finalization failed.",
          500,
        );
      }

      const project = await this.projects.getById(projectId);
      if (!project) {
        throw new UploadError(
          "PROJECT_NOT_FOUND",
          "Project was not found.",
          500,
        );
      }
      return project;
    } finally {
      await rm(input.filePath, { force: true });
    }
  }

  private resolveIdempotent(
    existing: { project: ProjectView; requestFingerprint: string },
    requestFingerprint: string,
  ): ProjectView {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new UploadError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different request.",
        409,
      );
    }
    return existing.project;
  }

  private async failAndCleanup(input: {
    projectId: string;
    artifactId: string;
    objectKey: string;
    code: string;
    message: string;
    cause: unknown;
  }): Promise<void> {
    try {
      await this.projects.markFailed(
        input.projectId,
        input.code,
        input.message,
        true,
      );
    } catch (error) {
      this.logger.error({
        event: "source_failure_persistence_failed",
        code: input.code,
        projectId: input.projectId,
        artifactId: input.artifactId,
        cause: safeCause(error),
      });
      return;
    }

    try {
      await this.storage.deleteObject(input.objectKey);
      await this.projects.markCleanupCompleted(input.artifactId);
    } catch (error) {
      try {
        await this.projects.recordCleanupFailure(
          input.artifactId,
          "OBJECT_DELETE_FAILED",
        );
      } catch (persistenceError) {
        this.logger.error({
          event: "source_cleanup_failure_persistence_failed",
          code: "OBJECT_DELETE_FAILED",
          projectId: input.projectId,
          artifactId: input.artifactId,
          cause: safeCause(persistenceError),
        });
      }
      this.logger.error({
        event: "source_cleanup_failed",
        code: "OBJECT_DELETE_FAILED",
        projectId: input.projectId,
        artifactId: input.artifactId,
        cause: safeCause(error),
      });
    }

    this.logger.error({
      event: "source_upload_failed",
      code: input.code,
      projectId: input.projectId,
      artifactId: input.artifactId,
      cause: safeCause(input.cause),
    });
  }

  private async cleanupAfterTerminalConflict(input: {
    projectId: string;
    artifactId: string;
    objectKey: string;
    cause: unknown;
  }): Promise<void> {
    try {
      await this.projects.requestCleanup(input.artifactId);
    } catch (error) {
      this.logger.error({
        event: "source_cleanup_intent_persistence_failed",
        code: "DATABASE_FINALIZE_CONFLICT",
        projectId: input.projectId,
        artifactId: input.artifactId,
        cause: safeCause(error),
      });
      return;
    }

    try {
      await this.storage.deleteObject(input.objectKey);
      await this.projects.markCleanupCompleted(input.artifactId);
    } catch (error) {
      try {
        await this.projects.recordCleanupFailure(
          input.artifactId,
          "OBJECT_DELETE_FAILED",
        );
      } catch (persistenceError) {
        this.logger.error({
          event: "source_cleanup_failure_persistence_failed",
          code: "OBJECT_DELETE_FAILED",
          projectId: input.projectId,
          artifactId: input.artifactId,
          cause: safeCause(persistenceError),
        });
      }
      this.logger.error({
        event: "source_cleanup_failed",
        code: "OBJECT_DELETE_FAILED",
        projectId: input.projectId,
        artifactId: input.artifactId,
        cause: safeCause(error),
      });
    }

    this.logger.error({
      event: "source_finalize_conflict",
      code: "DATABASE_FINALIZE_CONFLICT",
      projectId: input.projectId,
      artifactId: input.artifactId,
      cause: safeCause(input.cause),
    });
  }
}
