import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../database/prisma.service.js";
import {
  IdempotencyKeyAlreadyExistsError,
  TerminalStateConflictError,
  type CreatePendingUploadRecord,
  type ProjectRepository,
  type StorageReceipt,
} from "../application/project-repository.port.js";
import type {
  PendingCleanup,
  PendingUpload,
  ProjectView,
} from "../domain/project.js";

@Injectable()
export class PrismaProjectRepository implements ProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createPendingUpload(record: CreatePendingUploadRecord): Promise<void> {
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.project.create({
          data: {
            id: record.projectId,
            idempotencyKey: record.idempotencyKey,
            requestFingerprint: record.requestFingerprint,
            name: record.name,
            rightsConfirmedAt: record.rightsConfirmedAt,
            rightsDeclarationVersion: record.rightsDeclarationVersion,
          },
        });
        await transaction.videoSource.create({
          data: {
            id: record.sourceId,
            projectId: record.projectId,
            originalFilename: record.originalFilename,
            contentType: record.contentType,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
            sourceVersion: record.sourceVersion,
          },
        });
        await transaction.mediaArtifact.create({
          data: {
            id: record.artifactId,
            projectId: record.projectId,
            sourceId: record.sourceId,
            role: "SOURCE",
            objectKey: record.objectKey,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
            contentType: record.contentType,
            lineageSourceId: record.sourceId,
            lineageSourceVersion: record.sourceVersion,
            recipeVersion: record.recipeVersion,
          },
        });
      });
    } catch (error) {
      if (this.isUniqueConstraint(error))
        throw new IdempotencyKeyAlreadyExistsError();
      throw error;
    }
  }

  async finalizeReady(
    artifactId: string,
    receipt: StorageReceipt,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.mediaArtifact.findUnique({
        where: { id: artifactId },
        include: { project: true, source: true },
      });
      if (!current) throw new TerminalStateConflictError();
      if (this.isReady(current)) return;
      if (
        current.status !== "PENDING" ||
        current.source.status !== "PENDING" ||
        current.project.status !== "SOURCE_PENDING"
      ) {
        throw new TerminalStateConflictError();
      }

      const artifact = await transaction.mediaArtifact.updateMany({
        where: { id: artifactId, status: "PENDING" },
        data: {
          status: "READY",
          storageEtag: receipt.etag,
          storageVersion: receipt.version,
        },
      });
      if (artifact.count !== 1) {
        const concurrent = await transaction.mediaArtifact.findUnique({
          where: { id: artifactId },
          include: { project: true, source: true },
        });
        if (concurrent && this.isReady(concurrent)) return;
        throw new TerminalStateConflictError();
      }
      const source = await transaction.videoSource.updateMany({
        where: { id: current.sourceId, status: "PENDING" },
        data: { status: "READY" },
      });
      const project = await transaction.project.updateMany({
        where: { id: current.projectId, status: "SOURCE_PENDING" },
        data: {
          status: "SOURCE_READY",
          failureCode: null,
          failureMessage: null,
        },
      });
      if (source.count !== 1 || project.count !== 1)
        throw new TerminalStateConflictError();
    });
  }

  async markFailed(
    projectId: string,
    code: string,
    message: string,
    cleanupRequired: boolean,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.project.findUnique({
        where: { id: projectId },
        include: {
          source: true,
          artifacts: { where: { role: "SOURCE" }, take: 1 },
        },
      });
      const artifact = current?.artifacts[0];
      if (!current?.source || !artifact) throw new TerminalStateConflictError();
      if (
        current.status === "FAILED_FINAL" &&
        current.source.status === "FAILED_FINAL" &&
        artifact.status === "FAILED_FINAL" &&
        current.failureCode === code
      ) {
        if (cleanupRequired && artifact.cleanupStatus === "NOT_REQUIRED") {
          await transaction.mediaArtifact.update({
            where: { id: artifact.id },
            data: { cleanupStatus: "PENDING", cleanupRequestedAt: new Date() },
          });
        }
        return;
      }
      if (
        current.status !== "SOURCE_PENDING" ||
        current.source.status !== "PENDING" ||
        artifact.status !== "PENDING"
      ) {
        throw new TerminalStateConflictError();
      }

      const artifactUpdated = await transaction.mediaArtifact.updateMany({
        where: { id: artifact.id, status: "PENDING" },
        data: {
          status: "FAILED_FINAL",
          ...(cleanupRequired
            ? { cleanupStatus: "PENDING", cleanupRequestedAt: new Date() }
            : {}),
        },
      });
      if (artifactUpdated.count !== 1) throw new TerminalStateConflictError();
      const sourceUpdated = await transaction.videoSource.updateMany({
        where: { id: current.source.id, status: "PENDING" },
        data: { status: "FAILED_FINAL" },
      });
      const projectUpdated = await transaction.project.updateMany({
        where: { id: projectId, status: "SOURCE_PENDING" },
        data: {
          status: "FAILED_FINAL",
          failureCode: code,
          failureMessage: message,
        },
      });
      if (sourceUpdated.count !== 1 || projectUpdated.count !== 1) {
        throw new TerminalStateConflictError();
      }
    });
  }

  async requestCleanup(artifactId: string): Promise<void> {
    const requested = await this.prisma.mediaArtifact.updateMany({
      where: {
        id: artifactId,
        status: "FAILED_FINAL",
        cleanupStatus: "NOT_REQUIRED",
      },
      data: { cleanupStatus: "PENDING", cleanupRequestedAt: new Date() },
    });
    if (requested.count === 1) return;
    const existing = await this.prisma.mediaArtifact.findUnique({
      where: { id: artifactId },
      select: { status: true, cleanupStatus: true },
    });
    if (
      existing?.status === "FAILED_FINAL" &&
      (existing.cleanupStatus === "PENDING" ||
        existing.cleanupStatus === "COMPLETED")
    ) {
      return;
    }
    throw new TerminalStateConflictError();
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<{ project: ProjectView; requestFingerprint: string } | null> {
    const row = await this.prisma.project.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, requestFingerprint: true },
    });
    if (!row) return null;
    const project = await this.getById(row.id);
    return project
      ? { project, requestFingerprint: row.requestFingerprint }
      : null;
  }

  async getById(projectId: string): Promise<ProjectView | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        source: true,
        artifacts: { where: { role: "SOURCE" }, take: 1 },
      },
    });
    const source = project?.source;
    const artifact = project?.artifacts[0];
    if (!project || !source || !artifact) return null;
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      rightsConfirmedAt: project.rightsConfirmedAt,
      rightsDeclarationVersion: project.rightsDeclarationVersion,
      ...(project.failureCode && project.failureMessage
        ? {
            failure: {
              code: project.failureCode,
              message: project.failureMessage,
            },
          }
        : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      source: {
        id: source.id,
        status: source.status,
        sourceVersion: source.sourceVersion,
        originalFilename: source.originalFilename,
        contentType: source.contentType,
        sizeBytes: source.sizeBytes,
        sha256: source.sha256,
      },
      artifact: {
        id: artifact.id,
        role: artifact.role,
        status: artifact.status,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        contentType: artifact.contentType,
        lineageSourceId: artifact.lineageSourceId,
        lineageSourceVersion: artifact.lineageSourceVersion,
        recipeVersion: artifact.recipeVersion,
      },
    };
  }

  async findStalePending(
    before: Date,
    limit: number,
  ): Promise<PendingUpload[]> {
    const artifacts = await this.prisma.mediaArtifact.findMany({
      where: { status: "PENDING", role: "SOURCE", createdAt: { lt: before } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: {
        id: true,
        projectId: true,
        sourceId: true,
        objectKey: true,
        sizeBytes: true,
        sha256: true,
        createdAt: true,
      },
    });
    return artifacts.map((artifact) => ({
      projectId: artifact.projectId,
      sourceId: artifact.sourceId,
      artifactId: artifact.id,
      objectKey: artifact.objectKey,
      expectedSizeBytes: artifact.sizeBytes,
      expectedSha256: artifact.sha256,
      createdAt: artifact.createdAt,
    }));
  }

  async findPendingCleanup(limit: number): Promise<PendingCleanup[]> {
    const rows = await this.prisma.mediaArtifact.findMany({
      where: { cleanupStatus: "PENDING" },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { projectId: true, id: true, objectKey: true },
    });
    return rows.map((row) => ({
      projectId: row.projectId,
      artifactId: row.id,
      objectKey: row.objectKey,
    }));
  }

  async markCleanupCompleted(artifactId: string): Promise<void> {
    const result = await this.prisma.mediaArtifact.updateMany({
      where: { id: artifactId, cleanupStatus: "PENDING" },
      data: {
        cleanupStatus: "COMPLETED",
        cleanupCompletedAt: new Date(),
        cleanupLastErrorCode: null,
      },
    });
    if (result.count === 1) return;
    const existing = await this.prisma.mediaArtifact.findUnique({
      where: { id: artifactId },
      select: { cleanupStatus: true },
    });
    if (existing?.cleanupStatus !== "COMPLETED")
      throw new TerminalStateConflictError();
  }

  async recordCleanupFailure(
    artifactId: string,
    errorCode: string,
  ): Promise<void> {
    const result = await this.prisma.mediaArtifact.updateMany({
      where: { id: artifactId, cleanupStatus: "PENDING" },
      data: {
        cleanupAttemptCount: { increment: 1 },
        cleanupLastErrorCode: errorCode,
      },
    });
    if (result.count !== 1) throw new TerminalStateConflictError();
  }

  private isReady(current: {
    status: string;
    source: { status: string };
    project: { status: string };
  }): boolean {
    return (
      current.status === "READY" &&
      current.source.status === "READY" &&
      current.project.status === "SOURCE_READY"
    );
  }

  private isUniqueConstraint(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    );
  }
}
