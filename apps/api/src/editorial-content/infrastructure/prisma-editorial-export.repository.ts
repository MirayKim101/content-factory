import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import type { Prisma } from "../../generated/prisma/client.js";
import { sourceAuthorizationRuntime } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import { isSourceAuthorizationCleared } from "../../projects/domain/source-authorization.js";
import type { EditorialExportRepository } from "../application/editorial-export-repository.port.js";
import { HORIZONTAL_RENDER_CONTRACT } from "../domain/assembly-render.js";
import { EDITORIAL_APPROVAL_CONTRACT } from "../domain/editorial-approval.js";
import {
  EDITORIAL_EXPORT_CONTRACT,
  EDITORIAL_EXPORT_PROGRESS_SCHEMA,
  EditorialExportApprovalStaleError,
  EditorialExportAuthorizationError,
  EditorialExportCursorInvalidError,
  EditorialExportIdempotencyConflictError,
  EditorialExportLineageInvalidError,
  EditorialExportNotFoundError,
  type EditorialExportView,
} from "../domain/editorial-export.js";
import { montageRightsUsable } from "../domain/montage-asset.js";

const approvalInclude = {
  source: { include: { authorizations: true } },
  cutPipelineJob: { include: { resultArtifact: true } },
  editorialPackage: true,
  editorialPackageRevision: true,
  processingTemplateRevision: true,
  thumbnailAsset: true,
  assemblyRecipe: { select: { currentRevision: true } },
  recipeRevisionRecord: {
    include: { assetReferences: { include: { asset: true } } },
  },
  assemblyRenderIntent: {
    include: { pipelineJob: true, result: { include: { artifact: true } } },
  },
} satisfies Prisma.EditorialApprovalInclude;

const exportInclude = {
  approval: { include: approvalInclude },
  pipelineJob: true,
  result: { include: { artifact: true } },
} satisfies Prisma.EditorialExportIntentInclude;

type ApprovalRow = Prisma.EditorialApprovalGetPayload<{
  include: typeof approvalInclude;
}>;
type ExportRow = Prisma.EditorialExportIntentGetPayload<{
  include: typeof exportInclude;
}>;
type TransactionClient = Prisma.TransactionClient;

@Injectable()
export class PrismaEditorialExportRepository implements EditorialExportRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: Parameters<EditorialExportRepository["create"]>[0]) {
    return this.createWithRetry(input, 0);
  }

  private async createWithRetry(
    input: Parameters<EditorialExportRepository["create"]>[0],
    conflictCount: number,
  ): Promise<{
    view: EditorialExportView;
    delivery: { jobId: string; attemptNumber: number };
  }> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const approval = await this.findApproval(input.approvalId, tx);
          if (!approval) throw new EditorialExportNotFoundError();
          this.requireAuthorization(approval);

          const canonical = canonicalExportRequestFingerprint(approval);
          const operation = await tx.editorialOperationRequest.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (operation) {
            if (
              operation.operation !== "CREATE_EDITORIAL_EXPORT" ||
              operation.approvalId ||
              !operation.exportIntentId ||
              operation.resolvedProjectId !== approval.projectId ||
              operation.canonicalRequestFingerprint !== canonical
            ) {
              throw new EditorialExportIdempotencyConflictError();
            }
            const row = await this.findRow(operation.exportIntentId, tx);
            if (!row?.pipelineJob || row.approvalId !== approval.id)
              throw new EditorialExportLineageInvalidError();
            return this.delivery(row);
          }

          if (!this.approvalCurrent(approval))
            throw new EditorialExportApprovalStaleError();

          let row = await tx.editorialExportIntent.findUnique({
            where: {
              approvalId_exportContractVersion: {
                approvalId: approval.id,
                exportContractVersion: EDITORIAL_EXPORT_CONTRACT,
              },
            },
            include: exportInclude,
          });
          if (!row) {
            const intent = await tx.editorialExportIntent.create({
              data: {
                id: input.intentId,
                projectId: approval.projectId,
                sourceId: approval.sourceId,
                sourceVersion: approval.sourceVersion,
                cutPipelineJobId: approval.cutPipelineJobId,
                approvalId: approval.id,
                approvalCandidateFingerprint: approval.candidateFingerprint,
                editorialPackageRevisionId: approval.editorialPackageRevisionId,
                recipeRevisionId: approval.recipeRevisionId,
                assemblyRenderResultId: approval.assemblyRenderResultId,
                exportContractVersion: EDITORIAL_EXPORT_CONTRACT,
              },
            });
            await tx.pipelineJob.create({
              data: {
                id: input.jobId,
                projectId: approval.projectId,
                sourceId: approval.sourceId,
                sourceVersion: approval.sourceVersion,
                type: "EXPORT_EDITORIAL_PACKAGE",
                payloadVersion: 1,
                idempotencyKey: dispatchKey(intent.id, approval.projectId),
                recipeVersion: EDITORIAL_EXPORT_CONTRACT,
                retryBudget: 2,
                editorialExportIntentId: intent.id,
                attempts: {
                  create: {
                    id: input.attemptId,
                    attemptNumber: 1,
                    state: "QUEUED",
                  },
                },
              },
            });
            row = await this.findRow(intent.id, tx);
            if (!row?.pipelineJob)
              throw new EditorialExportLineageInvalidError();
          }

          await tx.editorialOperationRequest.create({
            data: {
              id: input.operationRequestId,
              idempotencyKey: input.idempotencyKey,
              operation: "CREATE_EDITORIAL_EXPORT",
              canonicalRequestFingerprint: canonical,
              resolvedProjectId: approval.projectId,
              exportIntentId: row.id,
            },
          });
          return this.delivery(row);
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (this.isControlled(error)) throw error;
      if (this.isTransactionConflict(error) || this.isUniqueConstraint(error)) {
        if (conflictCount < 5) {
          await new Promise((resolve) =>
            setTimeout(resolve, 5 * 2 ** conflictCount),
          );
          return this.createWithRetry(input, conflictCount + 1);
        }
        const recovered = await this.recoverReplay(input);
        if (recovered) return recovered;
        throw new EditorialExportIdempotencyConflictError();
      }
      const recovered = await this.recoverReplay(input);
      if (recovered) return recovered;
      throw error;
    }
  }

  private async recoverReplay(
    input: Parameters<EditorialExportRepository["create"]>[0],
  ): Promise<{
    view: EditorialExportView;
    delivery: { jobId: string; attemptNumber: number };
  } | null> {
    try {
      const approval = await this.findApproval(input.approvalId, this.prisma);
      if (!approval) return null;
      this.requireAuthorization(approval);
      const operation = await this.prisma.editorialOperationRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!operation) return null;
      if (
        operation.operation !== "CREATE_EDITORIAL_EXPORT" ||
        operation.approvalId ||
        !operation.exportIntentId ||
        operation.resolvedProjectId !== approval.projectId ||
        operation.canonicalRequestFingerprint !==
          canonicalExportRequestFingerprint(approval)
      ) {
        throw new EditorialExportIdempotencyConflictError();
      }
      const row = await this.findRow(operation.exportIntentId);
      if (!row?.pipelineJob || row.approvalId !== approval.id)
        throw new EditorialExportLineageInvalidError();
      return this.delivery(row);
    } catch (error) {
      if (this.isControlled(error)) throw error;
      return null;
    }
  }

  async get(exportId: string): Promise<EditorialExportView | null> {
    const row = await this.findRow(exportId);
    if (!row) return null;
    this.requireAuthorization(row.approval);
    return this.map(row);
  }

  async listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<EditorialExportView[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      include: { source: { include: { authorizations: true } } },
    });
    if (!project?.source) throw new EditorialExportAuthorizationError();
    if (
      !isSourceAuthorizationCleared(
        project.source.authorizations.find(
          (value) => value.sourceVersion === project.source!.sourceVersion,
        ) as Parameters<typeof isSourceAuthorizationCleared>[0],
        project.source.sourceVersion,
        sourceAuthorizationRuntime().policy,
      )
    ) {
      throw new EditorialExportAuthorizationError();
    }
    const anchor = input.cursor
      ? await this.prisma.editorialExportIntent.findFirst({
          where: { id: input.cursor, projectId: input.projectId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (input.cursor && !anchor) throw new EditorialExportCursorInvalidError();
    const rows = await this.prisma.editorialExportIntent.findMany({
      where: {
        projectId: input.projectId,
        ...(anchor
          ? {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      include: exportInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
    });
    return rows.map((row) => {
      this.requireAuthorization(row.approval);
      return this.map(row);
    });
  }

  async getContent(exportId: string) {
    const row = await this.findRow(exportId);
    if (!row) return null;
    this.requireAuthorization(row.approval);
    if (
      !this.approvalCurrent(row.approval) ||
      row.pipelineJob?.state !== "READY" ||
      row.pipelineJob.type !== "EXPORT_EDITORIAL_PACKAGE" ||
      row.pipelineJob.editorialExportIntentId !== row.id ||
      !row.result ||
      row.result.pipelineJobId !== row.pipelineJob.id ||
      row.result.exportContractVersion !== EDITORIAL_EXPORT_CONTRACT ||
      row.result.archiveSha256 !== row.result.artifact.sha256 ||
      row.result.archiveSizeBytes !== row.result.artifact.sizeBytes ||
      row.result.artifact.status !== "READY" ||
      row.result.artifact.role !== "EDITORIAL_EXPORT_PACKAGE" ||
      row.result.artifact.projectId !== row.projectId ||
      row.result.artifact.lineageSourceId !== row.sourceId ||
      row.result.artifact.lineageSourceVersion !== row.sourceVersion ||
      row.result.artifact.pipelineJobId !== row.pipelineJob.id ||
      row.result.artifact.contentType !== "application/zip"
    ) {
      return null;
    }
    return {
      objectKey: row.result.artifact.objectKey,
      sizeBytes: row.result.artifact.sizeBytes,
      filename: row.result.filename,
    };
  }

  private findApproval(id: string, client: PrismaService | TransactionClient) {
    return client.editorialApproval.findUnique({
      where: { id },
      include: approvalInclude,
    });
  }

  private findRow(
    id: string,
    client: PrismaService | TransactionClient = this.prisma,
  ) {
    return client.editorialExportIntent.findUnique({
      where: { id },
      include: exportInclude,
    });
  }

  private delivery(row: ExportRow) {
    if (!row.pipelineJob) throw new EditorialExportLineageInvalidError();
    return {
      view: this.map(row),
      delivery: {
        jobId: row.pipelineJob.id,
        attemptNumber: row.pipelineJob.attemptCount + 1,
      },
    };
  }

  private map(row: ExportRow): EditorialExportView {
    if (
      !row.pipelineJob ||
      row.pipelineJob.type !== "EXPORT_EDITORIAL_PACKAGE" ||
      row.pipelineJob.editorialExportIntentId !== row.id ||
      row.projectId !== row.approval.projectId ||
      row.sourceId !== row.approval.sourceId ||
      row.sourceVersion !== row.approval.sourceVersion ||
      row.cutPipelineJobId !== row.approval.cutPipelineJobId ||
      row.approvalCandidateFingerprint !== row.approval.candidateFingerprint ||
      row.editorialPackageRevisionId !==
        row.approval.editorialPackageRevisionId ||
      row.recipeRevisionId !== row.approval.recipeRevisionId ||
      row.assemblyRenderResultId !== row.approval.assemblyRenderResultId ||
      row.exportContractVersion !== EDITORIAL_EXPORT_CONTRACT
    ) {
      throw new EditorialExportLineageInvalidError();
    }
    const progress =
      row.pipelineJob.progressAttemptNumber &&
      row.pipelineJob.progressPhase &&
      row.pipelineJob.progressBasisPoints !== null &&
      row.pipelineJob.progressUpdatedAt &&
      [
        "READ_INPUTS",
        "WRITE_ARCHIVE",
        "OUTPUT_HASH",
        "UPLOAD",
        "FINALIZE",
      ].includes(row.pipelineJob.progressPhase)
        ? {
            schemaVersion: EDITORIAL_EXPORT_PROGRESS_SCHEMA,
            attemptNumber: row.pipelineJob.progressAttemptNumber,
            phase: row.pipelineJob.progressPhase as
              | "READ_INPUTS"
              | "WRITE_ARCHIVE"
              | "OUTPUT_HASH"
              | "UPLOAD"
              | "FINALIZE",
            basisPoints: row.pipelineJob.progressBasisPoints,
            updatedAt: row.pipelineJob.progressUpdatedAt,
          }
        : null;
    const result = row.result
      ? {
          filename: row.result.filename,
          sizeBytes: row.result.archiveSizeBytes,
          sha256: row.result.archiveSha256,
          manifest: row.result.manifest,
          completedAt: row.result.completedAt,
        }
      : null;
    return {
      id: row.id,
      projectId: row.projectId,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
      cutPipelineJobId: row.cutPipelineJobId,
      approvalId: row.approvalId,
      approvalCandidateFingerprint: row.approvalCandidateFingerprint,
      editorialPackageRevisionId: row.editorialPackageRevisionId,
      recipeRevisionId: row.recipeRevisionId,
      assemblyRenderResultId: row.assemblyRenderResultId,
      exportContractVersion: EDITORIAL_EXPORT_CONTRACT,
      approvalCurrent: this.approvalCurrent(row.approval),
      job: {
        id: row.pipelineJob.id,
        revision: row.pipelineJob.revision,
        state: row.pipelineJob.state,
        attempt: row.pipelineJob.attemptCount,
        retryBudget: row.pipelineJob.retryBudget,
        nextAttemptAt: row.pipelineJob.nextAttemptAt,
        admissionReason: row.pipelineJob.admissionReason,
        progress,
        failure:
          row.pipelineJob.failureCode && row.pipelineJob.failureMessage
            ? {
                code: row.pipelineJob.failureCode,
                message: row.pipelineJob.failureMessage,
                retryable: row.pipelineJob.failureRetryable === true,
              }
            : null,
      },
      result,
      createdAt: row.createdAt,
    };
  }

  private approvalCurrent(row: ApprovalRow): boolean {
    const render = row.assemblyRenderIntent;
    const tags = row.editorialPackageRevision.tags;
    return (
      row.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT &&
      row.renderContractVersion === HORIZONTAL_RENDER_CONTRACT &&
      row.editorialPackage.currentRevision === row.editorialRevision &&
      row.assemblyRecipe.currentRevision === row.recipeRevision &&
      row.editorialPackageRevision.id === row.editorialPackageRevisionId &&
      row.editorialPackageRevision.packageId === row.editorialPackageId &&
      row.editorialPackageRevision.revision === row.editorialRevision &&
      row.editorialPackageRevision.processingTemplateRevisionId ===
        row.processingTemplateRevisionId &&
      row.processingTemplateRevision.id === row.processingTemplateRevisionId &&
      row.processingTemplateRevision.configurationVersion ===
        "manual-editorial-v1" &&
      row.editorialPackageRevision.thumbnailAssetId === row.thumbnailAssetId &&
      Boolean(row.editorialPackageRevision.title?.trim()) &&
      Boolean(row.editorialPackageRevision.description?.trim()) &&
      Array.isArray(tags) &&
      tags.length > 0 &&
      row.editorialPackage.projectId === row.projectId &&
      row.editorialPackage.pipelineJobId === row.cutPipelineJobId &&
      row.editorialPackage.cutResultArtifactId ===
        row.cutPipelineJob.resultArtifact?.id &&
      row.editorialPackage.cutResultSha256 ===
        row.cutPipelineJob.resultArtifact.sha256 &&
      row.editorialPackage.cutResultSizeBytes ===
        row.cutPipelineJob.resultArtifact.sizeBytes &&
      row.editorialPackage.cutResultRecipeVersion ===
        row.cutPipelineJob.recipeVersion &&
      row.editorialPackage.lineageSourceId === row.sourceId &&
      row.editorialPackage.lineageSourceVersion === row.sourceVersion &&
      row.cutPipelineJob.type === "CUT_SEGMENT" &&
      row.cutPipelineJob.state === "READY" &&
      row.cutPipelineJob.projectId === row.projectId &&
      row.cutPipelineJob.sourceId === row.sourceId &&
      row.cutPipelineJob.sourceVersion === row.sourceVersion &&
      row.cutPipelineJob.resultArtifact?.role === "CUT_RESULT" &&
      row.cutPipelineJob.resultArtifact.status === "READY" &&
      row.cutPipelineJob.resultArtifact.projectId === row.projectId &&
      row.cutPipelineJob.resultArtifact.sourceId === row.sourceId &&
      row.cutPipelineJob.resultArtifact.lineageSourceId === row.sourceId &&
      row.cutPipelineJob.resultArtifact.lineageSourceVersion ===
        row.sourceVersion &&
      row.cutPipelineJob.resultArtifact.pipelineJobId ===
        row.cutPipelineJob.id &&
      row.cutPipelineJob.resultArtifact.recipeVersion ===
        row.cutPipelineJob.recipeVersion &&
      row.thumbnailAsset.projectId === row.projectId &&
      row.thumbnailAsset.type === "THUMBNAIL" &&
      row.thumbnailAsset.status === "READY" &&
      row.thumbnailAsset.sha256 === row.thumbnailSha256 &&
      row.thumbnailAsset.sizeBytes === row.thumbnailSizeBytes &&
      row.thumbnailAsset.contentType === row.thumbnailContentType &&
      ["image/jpeg", "image/png", "image/webp"].includes(
        row.thumbnailAsset.contentType,
      ) &&
      row.recipeRevisionRecord.id === row.recipeRevisionId &&
      row.recipeRevisionRecord.recipeId === row.assemblyRecipeId &&
      row.recipeRevisionRecord.revision === row.recipeRevision &&
      row.recipeRevisionRecord.configurationFingerprint ===
        row.configurationFingerprint &&
      row.recipeRevisionRecord.schemaVersion === "horizontal-assembly-v1" &&
      row.recipeRevisionRecord.audioProfileVersion === "youtube-stereo-v1" &&
      row.recipeRevisionRecord.encodingProfileVersion === "youtube-h264-v1" &&
      render.id === row.assemblyRenderIntentId &&
      render.projectId === row.projectId &&
      render.sourceId === row.sourceId &&
      render.sourceVersion === row.sourceVersion &&
      render.cutPipelineJobId === row.cutPipelineJobId &&
      render.assemblyRecipeId === row.assemblyRecipeId &&
      render.recipeRevisionId === row.recipeRevisionId &&
      render.recipeRevision === row.recipeRevision &&
      render.configurationFingerprint === row.configurationFingerprint &&
      render.renderContractVersion === HORIZONTAL_RENDER_CONTRACT &&
      render.audioProfileVersion ===
        row.recipeRevisionRecord.audioProfileVersion &&
      render.encodingProfileVersion ===
        row.recipeRevisionRecord.encodingProfileVersion &&
      render.pipelineJob?.type === "ASSEMBLE_HORIZONTAL" &&
      render.pipelineJob.projectId === row.projectId &&
      render.pipelineJob.sourceId === row.sourceId &&
      render.pipelineJob.sourceVersion === row.sourceVersion &&
      render.pipelineJob.assemblyRenderIntentId === render.id &&
      render.pipelineJob?.state === "READY" &&
      render.result?.id === row.assemblyRenderResultId &&
      render.result.renderIntentId === render.id &&
      render.result.artifact.id === row.renderArtifactId &&
      render.result.artifact.projectId === row.projectId &&
      render.result.artifact.sourceId === row.sourceId &&
      render.result.artifact.lineageSourceId === row.sourceId &&
      render.result.artifact.lineageSourceVersion === row.sourceVersion &&
      render.result.artifact.pipelineJobId === render.pipelineJob.id &&
      render.result.artifact.role === "HORIZONTAL_ASSEMBLY_RESULT" &&
      render.result.artifact.status === "READY" &&
      render.result.artifact.contentType === "video/mp4" &&
      render.result.artifact.recipeVersion === HORIZONTAL_RENDER_CONTRACT &&
      render.result.artifact.sha256 === row.renderArtifactSha256 &&
      render.result.artifact.sizeBytes === row.renderArtifactSizeBytes &&
      this.authorizationUsable(row) &&
      row.recipeRevisionRecord.assetReferences.every(
        (reference) =>
          reference.asset.id === reference.assetId &&
          reference.asset.projectId === row.projectId &&
          reference.asset.sourceId === row.sourceId &&
          reference.asset.sourceVersion === row.sourceVersion &&
          reference.asset.status === "READY" &&
          reference.asset.revision === reference.assetRevision &&
          reference.asset.sha256 === reference.assetSha256 &&
          reference.asset.sizeBytes === reference.assetSizeBytes &&
          reference.asset.kind === reference.assetKind &&
          reference.asset.durationMs === reference.assetDurationMs &&
          montageRightsUsable(
            reference.asset,
            sourceAuthorizationRuntime().policy,
          ),
      )
    );
  }

  private requireAuthorization(row: ApprovalRow): void {
    if (!this.authorizationUsable(row))
      throw new EditorialExportAuthorizationError();
  }

  private authorizationUsable(row: ApprovalRow): boolean {
    return (
      row.source.id === row.sourceId &&
      row.source.projectId === row.projectId &&
      row.source.sourceVersion === row.sourceVersion &&
      row.source.status === "READY" &&
      isSourceAuthorizationCleared(
        row.source.authorizations.find(
          (value) => value.sourceVersion === row.sourceVersion,
        ) as Parameters<typeof isSourceAuthorizationCleared>[0],
        row.sourceVersion,
        sourceAuthorizationRuntime().policy,
      )
    );
  }

  private isControlled(error: unknown): boolean {
    return (
      error instanceof EditorialExportAuthorizationError ||
      error instanceof EditorialExportApprovalStaleError ||
      error instanceof EditorialExportIdempotencyConflictError ||
      error instanceof EditorialExportLineageInvalidError ||
      error instanceof EditorialExportCursorInvalidError ||
      error instanceof EditorialExportNotFoundError
    );
  }

  private isTransactionConflict(error: unknown): boolean {
    const cause = driverCause(error);
    return (
      errorCode(error) === "P2034" ||
      cause?.originalCode === "40001" ||
      cause?.kind === "TransactionWriteConflict"
    );
  }

  private isUniqueConstraint(error: unknown): boolean {
    const cause = driverCause(error);
    return (
      errorCode(error) === "P2002" ||
      cause?.originalCode === "23505" ||
      cause?.kind === "UniqueConstraintViolation"
    );
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function driverCause(
  error: unknown,
): { originalCode?: unknown; kind?: unknown } | undefined {
  if (typeof error !== "object" || error === null || !("cause" in error))
    return undefined;
  const cause = error.cause;
  return typeof cause === "object" && cause !== null ? cause : undefined;
}

function canonicalExportRequestFingerprint(row: ApprovalRow): string {
  const tuple = [
    "CREATE_EDITORIAL_EXPORT",
    EDITORIAL_EXPORT_CONTRACT,
    row.id,
    row.projectId,
    row.sourceId,
    String(row.sourceVersion),
    row.cutPipelineJobId,
    row.candidateFingerprint,
    row.editorialPackageRevisionId,
    row.recipeRevisionId,
    row.assemblyRenderResultId,
  ];
  return createHash("sha256")
    .update(
      tuple.map((value) => `${Buffer.byteLength(value)}:${value}`).join("|"),
    )
    .digest("hex");
}

function dispatchKey(intentId: string, projectId: string): string {
  return createHash("sha256")
    .update(
      [
        "DISPATCH_EDITORIAL_EXPORT",
        EDITORIAL_EXPORT_CONTRACT,
        intentId,
        projectId,
      ].join("|"),
    )
    .digest("hex");
}
