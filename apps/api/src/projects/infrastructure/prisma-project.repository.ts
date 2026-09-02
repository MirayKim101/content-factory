import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../database/prisma.service.js";
import type { ProjectLibraryRepository } from "../application/project-library-repository.port.js";
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
  ProjectLibraryItem,
  ProjectListPage,
  ProjectListQuery,
  ProjectView,
} from "../domain/project.js";

@Injectable()
export class PrismaProjectRepository
  implements ProjectRepository, ProjectLibraryRepository
{
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
        source: {
          include: {
            pipelineJobs: {
              where: { type: "SOURCE_PROBE" },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        },
        artifacts: { where: { role: "SOURCE" }, take: 1 },
      },
    });
    const source = project?.source;
    const artifact = project?.artifacts[0];
    if (!project || !source || !artifact) return null;
    const probeJob = source.pipelineJobs[0];
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
        ...(source.durationMs === null
          ? {}
          : { durationMs: source.durationMs }),
        ...(probeJob ? { probeState: probeJob.state } : {}),
        ...(probeJob?.failureCode && probeJob.failureMessage
          ? {
              probeFailure: {
                code: probeJob.failureCode,
                message: probeJob.failureMessage,
              },
            }
          : {}),
      },
      artifact: {
        id: artifact.id,
        role: "SOURCE",
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

  async list(query: ProjectListQuery): Promise<ProjectListPage> {
    const status = query.status ?? null;
    const escapedSearch = query.q ? escapeLikePattern(query.q) : null;
    const cursorCreatedAt = query.cursor?.createdAt ?? null;
    const cursorId = query.cursor?.id ?? null;
    const rows = await this.prisma.$queryRaw<ProjectLibraryRow[]>`
      SELECT
        project.id,
        project.name,
        project.status::text AS status,
        project."createdAt",
        project."updatedAt",
        source.id AS "sourceId",
        source.status::text AS "sourceStatus",
        source."createdAt" AS "sourceAddedAt",
        source."originalFilename",
        source."contentType",
        source."sizeBytes",
        source."durationMs",
        probe.state::text AS "probeState",
        cuts.total AS "cutTotal",
        cuts.ready AS "cutReady",
        cuts.failed AS "cutFailed"
      FROM "Project" AS project
      INNER JOIN "VideoSource" AS source ON source."projectId" = project.id
      LEFT JOIN LATERAL (
        SELECT job.state
        FROM "PipelineJob" AS job
        WHERE job."sourceId" = source.id
          AND job.type = 'SOURCE_PROBE'::"PipelineJobType"
        ORDER BY job."createdAt" DESC, job.id DESC
        LIMIT 1
      ) AS probe ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE job.state = 'READY'::"PipelineJobState"
          )::int AS ready,
          COUNT(*) FILTER (
            WHERE job.state = 'FAILED_FINAL'::"PipelineJobState"
          )::int AS failed
        FROM "PipelineJob" AS job
        WHERE job."projectId" = project.id
          AND job.type = 'CUT_SEGMENT'::"PipelineJobType"
      ) AS cuts ON TRUE
      WHERE (${status}::text IS NULL OR project.status::text = ${status}::text)
        AND (
          ${escapedSearch}::text IS NULL
          OR project.name ILIKE ('%' || ${escapedSearch}::text || '%') ESCAPE E'\\\\'
          OR source."originalFilename" ILIKE ('%' || ${escapedSearch}::text || '%') ESCAPE E'\\\\'
        )
        AND (
          ${cursorCreatedAt}::timestamptz IS NULL
          OR (project."createdAt", project.id) < (
            ${cursorCreatedAt}::timestamptz,
            ${cursorId}::uuid
          )
        )
      ORDER BY project."createdAt" DESC, project.id DESC
      LIMIT ${query.limit + 1}
    `;

    const hasMore = rows.length > query.limit;
    const visibleRows = rows.slice(0, query.limit);
    const items: ProjectLibraryItem[] = visibleRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      source: {
        id: row.sourceId,
        status: row.sourceStatus,
        addedAt: row.sourceAddedAt,
        originalFilename: row.originalFilename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
        ...(row.probeState === null ? {} : { probeState: row.probeState }),
      },
      cutJobCounts: {
        total: row.cutTotal,
        ready: row.cutReady,
        failed: row.cutFailed,
      },
    }));
    const last = visibleRows.at(-1);

    return {
      items,
      nextCursor:
        hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
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

interface ProjectLibraryRow {
  id: string;
  name: string;
  status: ProjectLibraryItem["status"];
  createdAt: Date;
  updatedAt: Date;
  sourceId: string;
  sourceStatus: ProjectLibraryItem["source"]["status"];
  sourceAddedAt: Date;
  originalFilename: string;
  contentType: string;
  sizeBytes: bigint;
  durationMs: number | null;
  probeState: ProjectLibraryItem["source"]["probeState"] | null;
  cutTotal: number;
  cutReady: number;
  cutFailed: number;
}

function escapeLikePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
