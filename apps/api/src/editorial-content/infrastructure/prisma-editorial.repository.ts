import { Injectable } from "@nestjs/common";

import { sourceAuthorizationRuntime } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import {
  isSourceAuthorizationCleared,
  SourceAuthorizationRequiredError,
} from "../../projects/domain/source-authorization.js";
import type {
  EditorialAssetView,
  EditorialPackageView,
  ProcessingTemplateRevisionView,
  ThumbnailContentType,
} from "../domain/editorial.js";
import { editorialValidation } from "../domain/editorial.js";
import {
  EditorialAssetNotFoundError,
  EditorialAssetProjectMismatchError,
  EditorialCutArtifactInvalidError,
  EditorialCutNotReadyError,
  EditorialIdempotencyConflictError,
  EditorialPersistenceConflictError,
  EditorialProjectNotFoundError,
  EditorialRevisionConflictError,
  ProcessingTemplateRevisionNotFoundError,
  type EditorialRepository,
} from "../application/editorial-repository.port.js";

const packageInclude = {
  cutResultArtifact: true,
  pipelineJob: {
    include: { source: { include: { authorizations: true } } },
  },
  revisions: {
    include: {
      processingTemplateRevision: true,
      thumbnailAsset: true,
    },
    orderBy: { revision: "desc" as const },
  },
} as const;

type PackageRow =
  Awaited<
    ReturnType<PrismaEditorialRepository["findPackageRow"]>
  > extends infer T
    ? NonNullable<T>
    : never;
type SavePackageInput = Parameters<EditorialRepository["savePackage"]>[0];

@Injectable()
export class PrismaEditorialRepository implements EditorialRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createTemplate(input: {
    templateId: string;
    revisionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    name: string;
  }): Promise<ProcessingTemplateRevisionView> {
    try {
      const template = await this.prisma.processingTemplate.create({
        data: {
          id: input.templateId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          revisions: {
            create: {
              id: input.revisionId,
              revision: 1,
              name: input.name,
              configurationVersion: "manual-editorial-v1",
            },
          },
        },
        include: { revisions: true },
      });
      return this.mapTemplate(template.revisions[0]!);
    } catch (error) {
      if (!this.isUniqueConstraint(error)) throw error;
      const existing = await this.prisma.processingTemplate.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
      });
      if (
        !existing ||
        existing.requestFingerprint !== input.requestFingerprint ||
        !existing.revisions[0]
      ) {
        throw new EditorialIdempotencyConflictError();
      }
      return this.mapTemplate(existing.revisions[0]);
    }
  }

  async listTemplates(): Promise<ProcessingTemplateRevisionView[]> {
    const templates = await this.prisma.processingTemplateRevision.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return templates.map((template) => this.mapTemplate(template));
  }

  async findAssetByIdempotencyKey(key: string) {
    const row = await this.prisma.editorialAsset.findUnique({
      where: { idempotencyKey: key },
    });
    return row
      ? {
          asset: this.mapAsset(row),
          requestFingerprint: row.requestFingerprint,
        }
      : null;
  }

  async createPendingAsset(input: {
    id: string;
    projectId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    objectKey: string;
    originalFilename: string;
    contentType: ThumbnailContentType;
    sizeBytes: bigint;
    sha256: string;
    width: number;
    height: number;
  }): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) throw new EditorialProjectNotFoundError();
    try {
      await this.prisma.editorialAsset.create({
        data: {
          ...input,
          type: "THUMBNAIL",
        },
      });
    } catch (error) {
      if (this.isUniqueConstraint(error)) {
        throw new EditorialIdempotencyConflictError();
      }
      throw error;
    }
  }

  async finalizeAsset(
    id: string,
    receipt: { etag?: string; version?: string },
  ): Promise<EditorialAssetView> {
    const updated = await this.prisma.editorialAsset.updateManyAndReturn({
      where: { id, status: "PENDING" },
      data: {
        status: "READY",
        storageEtag: receipt.etag,
        storageVersion: receipt.version,
      },
    });
    if (updated[0]) return this.mapAsset(updated[0]);
    const existing = await this.prisma.editorialAsset.findUnique({
      where: { id },
    });
    if (existing?.status === "READY") return this.mapAsset(existing);
    throw new EditorialPersistenceConflictError();
  }

  async failAsset(id: string, code: string, message: string): Promise<void> {
    const updated = await this.prisma.editorialAsset.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: "FAILED_FINAL",
        failureCode: code,
        failureMessage: message,
        cleanupStatus: "PENDING",
        cleanupRequestedAt: new Date(),
      },
    });
    if (updated.count === 1) return;
    const existing = await this.prisma.editorialAsset.findUnique({
      where: { id },
      select: { status: true },
    });
    if (existing?.status !== "FAILED_FINAL") {
      throw new EditorialPersistenceConflictError();
    }
  }

  async completeAssetCleanup(id: string): Promise<void> {
    await this.prisma.editorialAsset.updateMany({
      where: { id, cleanupStatus: "PENDING" },
      data: { cleanupStatus: "COMPLETED", cleanupCompletedAt: new Date() },
    });
  }

  async recordAssetCleanupFailure(id: string, code: string): Promise<void> {
    await this.prisma.editorialAsset.updateMany({
      where: { id, cleanupStatus: "PENDING" },
      data: {
        cleanupAttemptCount: { increment: 1 },
        cleanupLastErrorCode: code,
      },
    });
  }

  async getAssetFinalization(id: string): Promise<EditorialAssetView | null> {
    const row = await this.prisma.editorialAsset.findUnique({ where: { id } });
    return row ? this.mapAsset(row) : null;
  }

  async listRecoverableAssets(input: { staleBefore: Date; limit: number }) {
    const rows = await this.prisma.editorialAsset.findMany({
      where: {
        OR: [
          {
            status: "PENDING",
            cleanupStatus: "NOT_REQUIRED",
            updatedAt: { lt: input.staleBefore },
          },
          { status: "FAILED_FINAL", cleanupStatus: "PENDING" },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: input.limit,
      select: {
        id: true,
        status: true,
        cleanupStatus: true,
        objectKey: true,
        sizeBytes: true,
        sha256: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      status: row.status as "PENDING" | "FAILED_FINAL",
      cleanupStatus: row.cleanupStatus as "NOT_REQUIRED" | "PENDING",
    }));
  }

  async listAssets(projectId: string): Promise<EditorialAssetView[]> {
    await this.requireProject(projectId);
    const rows = await this.prisma.editorialAsset.findMany({
      where: { projectId, type: "THUMBNAIL", status: "READY" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return rows.map((row) => this.mapAsset(row));
  }

  async getAsset(projectId: string, assetId: string) {
    await this.requireProject(projectId);
    const row = await this.prisma.editorialAsset.findFirst({
      where: {
        id: assetId,
        projectId,
        type: "THUMBNAIL",
        status: "READY",
      },
    });
    return row ? { asset: this.mapAsset(row), objectKey: row.objectKey } : null;
  }

  async savePackage(input: SavePackageInput): Promise<EditorialPackageView> {
    return this.savePackageWithRetry(input, 0);
  }

  private async savePackageWithRetry(
    input: SavePackageInput,
    transactionConflictCount: number,
  ): Promise<EditorialPackageView> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const replay = await transaction.editorialMutationRequest.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            select: {
              requestFingerprint: true,
              packageRevision: { select: { packageId: true, revision: true } },
            },
          });
          if (replay) {
            if (replay.requestFingerprint !== input.requestFingerprint) {
              throw new EditorialIdempotencyConflictError();
            }
            const row = await this.findPackageRow(
              replay.packageRevision.packageId,
              transaction,
            );
            if (!row) throw new EditorialPersistenceConflictError();
            return this.mapPackage(row, replay.packageRevision.revision);
          }

          const job = await transaction.pipelineJob.findUnique({
            where: { id: input.pipelineJobId },
            include: {
              resultArtifact: true,
              source: { include: { authorizations: true } },
            },
          });
          if (!job || job.type !== "CUT_SEGMENT" || job.state !== "READY") {
            throw new EditorialCutNotReadyError();
          }
          this.requireAuthorization(
            job.sourceVersion,
            job.source.authorizations,
          );
          const artifact = job.resultArtifact;
          if (
            !artifact ||
            artifact.status !== "READY" ||
            artifact.role !== "CUT_RESULT" ||
            artifact.projectId !== job.projectId ||
            artifact.sourceId !== job.sourceId ||
            artifact.lineageSourceId !== job.sourceId ||
            artifact.lineageSourceVersion !== job.sourceVersion ||
            artifact.pipelineJobId !== job.id ||
            artifact.recipeVersion !== job.recipeVersion ||
            !this.isSha256(artifact.sha256) ||
            artifact.sizeBytes <= 0n
          ) {
            throw new EditorialCutArtifactInvalidError();
          }
          const template =
            await transaction.processingTemplateRevision.findUnique({
              where: { id: input.processingTemplateRevisionId },
            });
          if (!template) throw new ProcessingTemplateRevisionNotFoundError();
          if (input.thumbnailAssetId) {
            const thumbnail = await transaction.editorialAsset.findUnique({
              where: { id: input.thumbnailAssetId },
            });
            if (!thumbnail) throw new EditorialAssetNotFoundError();
            if (thumbnail.projectId !== job.projectId) {
              throw new EditorialAssetProjectMismatchError();
            }
            if (
              thumbnail.type !== "THUMBNAIL" ||
              thumbnail.status !== "READY"
            ) {
              throw new EditorialAssetNotFoundError();
            }
          }

          const current = await transaction.editorialPackage.findUnique({
            where: { pipelineJobId: job.id },
          });
          const nextRevision = input.expectedRevision + 1;
          if (!current) {
            if (input.expectedRevision !== 0) {
              throw new EditorialRevisionConflictError();
            }
            await transaction.editorialPackage.create({
              data: {
                id: input.packageId,
                projectId: job.projectId,
                pipelineJobId: job.id,
                cutResultArtifactId: artifact.id,
                cutResultSha256: artifact.sha256,
                cutResultSizeBytes: artifact.sizeBytes,
                cutResultRecipeVersion: artifact.recipeVersion,
                lineageSourceId: artifact.lineageSourceId,
                lineageSourceVersion: artifact.lineageSourceVersion,
                currentRevision: 1,
                revisions: {
                  create: this.revisionCreateData(input, 1),
                },
              },
            });
            const created = await this.findPackageRow(
              input.packageId,
              transaction,
            );
            if (!created) throw new EditorialPersistenceConflictError();
            return this.mapPackage(created, 1);
          }
          if (
            current.currentRevision !== input.expectedRevision ||
            current.cutResultArtifactId !== artifact.id ||
            current.projectId !== job.projectId ||
            current.cutResultSha256 !== artifact.sha256 ||
            current.cutResultSizeBytes !== artifact.sizeBytes ||
            current.cutResultRecipeVersion !== artifact.recipeVersion ||
            current.lineageSourceId !== artifact.lineageSourceId ||
            current.lineageSourceVersion !== artifact.lineageSourceVersion
          ) {
            throw new EditorialRevisionConflictError();
          }
          const advanced = await transaction.editorialPackage.updateMany({
            where: {
              id: current.id,
              currentRevision: input.expectedRevision,
              cutResultArtifactId: artifact.id,
            },
            data: { currentRevision: nextRevision },
          });
          if (advanced.count !== 1) throw new EditorialRevisionConflictError();
          await transaction.editorialPackageRevision.create({
            data: {
              packageId: current.id,
              ...this.revisionCreateData(input, nextRevision),
            },
          });
          const updated = await this.findPackageRow(current.id, transaction);
          if (!updated) throw new EditorialPersistenceConflictError();
          return this.mapPackage(updated, nextRevision);
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (
        error instanceof EditorialIdempotencyConflictError ||
        error instanceof EditorialProjectNotFoundError ||
        error instanceof EditorialAssetNotFoundError ||
        error instanceof EditorialAssetProjectMismatchError ||
        error instanceof ProcessingTemplateRevisionNotFoundError ||
        error instanceof EditorialCutNotReadyError ||
        error instanceof EditorialCutArtifactInvalidError ||
        error instanceof EditorialRevisionConflictError ||
        error instanceof EditorialPersistenceConflictError
      ) {
        throw error;
      }
      if (this.isTransactionConflict(error)) {
        if (transactionConflictCount < 4) {
          await this.waitForConcurrentCommit(transactionConflictCount);
          return this.savePackageWithRetry(input, transactionConflictCount + 1);
        }
        throw new EditorialRevisionConflictError();
      }
      if (!this.isUniqueConstraint(error)) throw error;
      const replay = await this.prisma.editorialMutationRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: {
          requestFingerprint: true,
          packageRevision: { select: { packageId: true, revision: true } },
        },
      });
      if (replay && replay.requestFingerprint !== input.requestFingerprint) {
        throw new EditorialIdempotencyConflictError();
      }
      if (!replay) {
        if (transactionConflictCount < 4) {
          await this.waitForConcurrentCommit(transactionConflictCount);
          return this.savePackageWithRetry(input, transactionConflictCount + 1);
        }
        throw new EditorialRevisionConflictError();
      }
      const row = await this.findPackageRow(replay.packageRevision.packageId);
      if (!row) throw new EditorialPersistenceConflictError();
      return this.mapPackage(row, replay.packageRevision.revision);
    }
  }

  async getPackage(
    pipelineJobId: string,
  ): Promise<EditorialPackageView | null> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: pipelineJobId },
      include: { source: { include: { authorizations: true } } },
    });
    if (!job) return null;
    if (job.type !== "CUT_SEGMENT" || job.state !== "READY") {
      throw new EditorialCutNotReadyError();
    }
    this.requireAuthorization(job.sourceVersion, job.source.authorizations);
    const row = await this.prisma.editorialPackage.findUnique({
      where: { pipelineJobId },
      include: packageInclude,
    });
    return row ? this.mapPackage(row, row.currentRevision) : null;
  }

  async listPackages(projectId: string): Promise<EditorialPackageView[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { source: { include: { authorizations: true } } },
    });
    if (!project) throw new EditorialProjectNotFoundError();
    if (!project.source) throw new SourceAuthorizationRequiredError();
    this.requireAuthorization(
      project.source.sourceVersion,
      project.source.authorizations,
    );
    const rows = await this.prisma.editorialPackage.findMany({
      where: { projectId },
      include: packageInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    return rows.map((row) => this.mapPackage(row, row.currentRevision));
  }

  private revisionCreateData(
    input: {
      revisionId: string;
      mutationId: string;
      idempotencyKey: string;
      requestFingerprint: string;
      processingTemplateRevisionId: string;
      title: string | null;
      description: string | null;
      tags: string[] | null;
      thumbnailAssetId: string | null;
    },
    revision: number,
  ) {
    return {
      id: input.revisionId,
      revision,
      processingTemplateRevisionId: input.processingTemplateRevisionId,
      title: input.title,
      description: input.description,
      tags: input.tags ?? undefined,
      thumbnailAssetId: input.thumbnailAssetId,
      mutationRequests: {
        create: {
          id: input.mutationId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        },
      },
    };
  }

  private async findPackageRow(
    packageId: string,
    client: Pick<PrismaService, "editorialPackage"> = this.prisma,
  ) {
    return client.editorialPackage.findUnique({
      where: { id: packageId },
      include: packageInclude,
    });
  }

  private mapPackage(
    row: PackageRow,
    revisionNumber: number,
  ): EditorialPackageView {
    if (
      row.pipelineJob.type !== "CUT_SEGMENT" ||
      row.pipelineJob.state !== "READY"
    ) {
      throw new EditorialCutNotReadyError();
    }
    this.requireAuthorization(
      row.pipelineJob.sourceVersion,
      row.pipelineJob.source.authorizations,
    );
    if (
      row.cutResultArtifact.status !== "READY" ||
      row.cutResultArtifact.role !== "CUT_RESULT" ||
      row.cutResultArtifact.id !== row.cutResultArtifactId ||
      row.cutResultArtifact.projectId !== row.projectId ||
      row.cutResultArtifact.sourceId !== row.pipelineJob.sourceId ||
      row.cutResultArtifact.lineageSourceId !== row.pipelineJob.sourceId ||
      row.cutResultArtifact.lineageSourceVersion !==
        row.pipelineJob.sourceVersion ||
      row.cutResultArtifact.pipelineJobId !== row.pipelineJobId ||
      row.cutResultArtifact.recipeVersion !== row.pipelineJob.recipeVersion ||
      !this.isSha256(row.cutResultArtifact.sha256) ||
      row.cutResultArtifact.sizeBytes <= 0n ||
      row.cutResultSha256 !== row.cutResultArtifact.sha256 ||
      row.cutResultSizeBytes !== row.cutResultArtifact.sizeBytes ||
      row.cutResultRecipeVersion !== row.cutResultArtifact.recipeVersion ||
      row.lineageSourceId !== row.cutResultArtifact.lineageSourceId ||
      row.lineageSourceVersion !== row.cutResultArtifact.lineageSourceVersion
    ) {
      throw new EditorialCutArtifactInvalidError();
    }
    const revision = row.revisions.find(
      (candidate) => candidate.revision === revisionNumber,
    );
    if (!revision) throw new EditorialPersistenceConflictError();
    const tags = this.mapTags(revision.tags);
    const thumbnail = revision.thumbnailAsset
      ? this.mapAsset(revision.thumbnailAsset)
      : null;
    return {
      id: row.id,
      projectId: row.projectId,
      pipelineJobId: row.pipelineJobId,
      cutResultArtifact: {
        id: row.cutResultArtifact.id,
        sha256: row.cutResultSha256,
        sizeBytes: row.cutResultSizeBytes,
        sourceId: row.lineageSourceId,
        sourceVersion: row.lineageSourceVersion,
        recipeVersion: row.cutResultRecipeVersion,
      },
      revision: {
        id: revision.id,
        revision: revision.revision,
        processingTemplateRevision: this.mapTemplate(
          revision.processingTemplateRevision,
        ),
        title: revision.title,
        description: revision.description,
        tags,
        thumbnail,
        createdAt: revision.createdAt,
      },
      validation: editorialValidation({
        title: revision.title,
        description: revision.description,
        tags,
        thumbnail,
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapTemplate(row: {
    id: string;
    templateId: string;
    revision: number;
    name: string;
    configurationVersion: string;
    createdAt: Date;
  }): ProcessingTemplateRevisionView {
    return { ...row };
  }

  private mapAsset(row: {
    id: string;
    projectId: string;
    type: "THUMBNAIL";
    status: "PENDING" | "READY" | "FAILED_FINAL";
    originalFilename: string;
    contentType: string;
    sizeBytes: bigint;
    sha256: string;
    width: number;
    height: number;
    failureCode: string | null;
    failureMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): EditorialAssetView {
    if (
      row.contentType !== "image/jpeg" &&
      row.contentType !== "image/png" &&
      row.contentType !== "image/webp"
    ) {
      throw new EditorialPersistenceConflictError();
    }
    return {
      id: row.id,
      projectId: row.projectId,
      type: row.type,
      status: row.status,
      originalFilename: row.originalFilename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      width: row.width,
      height: row.height,
      ...(row.failureCode && row.failureMessage
        ? { failure: { code: row.failureCode, message: row.failureMessage } }
        : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapTags(value: unknown): string[] | null {
    if (value === null) return null;
    if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
      throw new EditorialPersistenceConflictError();
    }
    return value;
  }

  private async requireProject(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new EditorialProjectNotFoundError();
  }

  private isUniqueConstraint(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    );
  }

  private isTransactionConflict(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2034"
    );
  }

  private isSha256(value: string): boolean {
    return /^[a-f0-9]{64}$/.test(value);
  }

  private waitForConcurrentCommit(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
  }

  private requireAuthorization(
    sourceVersion: number,
    authorizations: Array<{
      sourceVersion: number;
      status: "NOT_REVIEWED" | "CLEARED";
      basis:
        | "LEGACY_ATTESTATION"
        | "OPERATOR_ATTESTATION"
        | "LOCAL_DEVELOPMENT_AUTO"
        | null;
      declarationVersion: string | null;
      decidedAt: Date | null;
      revision: number;
    }>,
  ): void {
    const authorization = authorizations.find(
      (candidate) => candidate.sourceVersion === sourceVersion,
    );
    const view = authorization
      ? {
          sourceVersion: authorization.sourceVersion,
          status: authorization.status,
          revision: authorization.revision,
          ...(authorization.basis ? { basis: authorization.basis } : {}),
          ...(authorization.declarationVersion
            ? { declarationVersion: authorization.declarationVersion }
            : {}),
          ...(authorization.decidedAt
            ? { decidedAt: authorization.decidedAt }
            : {}),
        }
      : null;
    if (
      !isSourceAuthorizationCleared(
        view,
        sourceVersion,
        sourceAuthorizationRuntime().policy,
      )
    ) {
      throw new SourceAuthorizationRequiredError();
    }
  }
}
