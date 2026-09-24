import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  LOCAL_NO_LIKENESS_PROMPT_BASIS_VERSION,
  LOCAL_NO_LIKENESS_THUMBNAIL_ADAPTER_VERSION,
  THUMBNAIL_CONTRACT_VERSION,
  projectNoLikenessSafetyDecision,
} from "@content-factory/contracts";

import type { Prisma } from "../../generated/prisma/client.js";
import { sourceAuthorizationRuntime } from "../../config/environment.js";
import { normalizePublicCitationUrl } from "../../ai-content/research/public-citation-url.js";
import { PrismaService } from "../../database/prisma.service.js";
import { isSourceAuthorizationCleared } from "../../projects/domain/source-authorization.js";
import type { EditorialExportRepository } from "../application/editorial-export-repository.port.js";
import { HORIZONTAL_RENDER_CONTRACT } from "../domain/assembly-render.js";
import {
  EDITORIAL_APPROVAL_CONTRACT,
  EDITORIAL_APPROVAL_CONTRACT_V2,
} from "../domain/editorial-approval.js";
import {
  EDITORIAL_EXPORT_CONTRACT,
  EDITORIAL_EXPORT_CONTRACT_V2,
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
  componentSnapshots: {
    include: { provenance: true, suggestionSet: true, imageCandidate: true },
  },
  economicsV2: true,
  source: { include: { authorizations: true } },
  cutPipelineJob: { include: { resultArtifact: true } },
  editorialPackage: true,
  editorialPackageRevision: { include: { componentProvenance: true } },
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
          const exportContractVersion = exportContractForApproval(
            approval.approvalContractVersion,
          );

          let row = await tx.editorialExportIntent.findUnique({
            where: {
              approvalId_exportContractVersion: {
                approvalId: approval.id,
                exportContractVersion,
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
                exportContractVersion,
              },
            });
            await tx.pipelineJob.create({
              data: {
                id: input.jobId,
                projectId: approval.projectId,
                sourceId: approval.sourceId,
                sourceVersion: approval.sourceVersion,
                type: "EXPORT_EDITORIAL_PACKAGE",
                payloadVersion:
                  exportContractVersion === EDITORIAL_EXPORT_CONTRACT_V2
                    ? 2
                    : 1,
                idempotencyKey: dispatchKey(
                  intent.id,
                  approval.projectId,
                  exportContractVersion,
                ),
                recipeVersion: exportContractVersion,
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
      row.result.exportContractVersion !== row.exportContractVersion ||
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
      row.exportContractVersion !==
        exportContractForApproval(row.approval.approvalContractVersion)
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
      exportContractVersion:
        row.exportContractVersion === EDITORIAL_EXPORT_CONTRACT_V2
          ? EDITORIAL_EXPORT_CONTRACT_V2
          : EDITORIAL_EXPORT_CONTRACT,
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
      approvalSnapshotCurrent(row) &&
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

function approvalSnapshotCurrent(row: ApprovalRow): boolean {
  if (row.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT) {
    return row.editorialPackageRevision.componentProvenance.every(
      (value) => value.mode === "MANUAL",
    );
  }
  if (row.approvalContractVersion !== EDITORIAL_APPROVAL_CONTRACT_V2)
    return false;
  const economics = row.economicsV2;
  const metadata = row.componentSnapshots.find(
    (value) => value.component === "METADATA",
  );
  const thumbnail = row.componentSnapshots.find(
    (value) => value.component === "THUMBNAIL",
  );
  if (
    row.componentSnapshots.length !== 2 ||
    !metadata ||
    !thumbnail ||
    !economics
  )
    return false;
  for (const snapshot of [metadata, thumbnail]) {
    const provenance = snapshot.provenance;
    if (
      snapshot.editorialPackageRevisionId !== row.editorialPackageRevisionId ||
      provenance.packageRevisionId !== row.editorialPackageRevisionId ||
      snapshot.provenanceId !== provenance.id ||
      snapshot.component !== provenance.component ||
      snapshot.mode !== provenance.mode ||
      snapshot.basisVersion !== provenance.basisVersion ||
      snapshot.researchIntentId !== provenance.researchIntentId ||
      snapshot.suggestionSetId !== provenance.suggestionSetId ||
      snapshot.imageIntentId !== provenance.imageIntentId ||
      snapshot.imageCandidateId !== provenance.imageCandidateId
    )
      return false;
  }
  const workflowMode =
    metadata.mode === "MANUAL" && thumbnail.mode === "MANUAL"
      ? "MANUAL"
      : metadata.mode === "AI_ASSISTED" && thumbnail.mode === "AI_ASSISTED"
        ? "AI_ASSISTED"
        : "MIXED";
  return (
    metadata.directCostMicrousd ===
      (metadata.suggestionSet?.directCostMicrousd ?? 0n) &&
    metadata.costBasisVersion ===
      (metadata.suggestionSet?.costBasisVersion ?? metadata.basisVersion) &&
    thumbnail.directCostMicrousd ===
      (thumbnail.imageCandidate?.directCostMicrousd ?? 0n) &&
    thumbnail.costBasisVersion ===
      (thumbnail.imageCandidate?.costBasisVersion ?? thumbnail.basisVersion) &&
    economics.workflowMode === workflowMode &&
    economics.totalOperatorAttentionMs ===
      economics.preparationForegroundMs + economics.finalReviewForegroundMs &&
    economics.metadataDirectCostMicrousd === metadata.directCostMicrousd &&
    economics.thumbnailDirectCostMicrousd === thumbnail.directCostMicrousd &&
    economics.combinedDirectCostMicrousd ===
      economics.metadataDirectCostMicrousd +
        economics.evidenceDirectCostMicrousd +
        economics.thumbnailDirectCostMicrousd &&
    economics.metadataCostBasisVersion === metadata.costBasisVersion &&
    economics.thumbnailCostBasisVersion === thumbnail.costBasisVersion &&
    validV2SnapshotFingerprints([metadata, thumbnail], economics)
  );
}

function validV2SnapshotFingerprints(
  components: ApprovalRow["componentSnapshots"],
  economics: NonNullable<ApprovalRow["economicsV2"]>,
): boolean {
  const byComponent = new Map<
    "METADATA" | "THUMBNAIL",
    ApprovalRow["componentSnapshots"][number]
  >();
  for (const component of components) {
    if (byComponent.has(component.component)) return false;
    const citations = Array.isArray(component.citations)
      ? component.citations.map((citation) => {
          if (!citation || typeof citation !== "object") return citation;
          const row = citation as Record<string, unknown>;
          return {
            ...row,
            publishedAt:
              typeof row.publishedAt === "string"
                ? new Date(row.publishedAt)
                : null,
            accessedAt:
              typeof row.accessedAt === "string"
                ? new Date(row.accessedAt)
                : row.accessedAt,
          };
        })
      : component.citations;
    if (
      component.component === "METADATA" &&
      (!Array.isArray(citations) ||
        citations.some((citation) => !validPersistedPublicCitation(citation)))
    )
      return false;
    const freshness =
      component.freshness && typeof component.freshness === "object"
        ? {
            ...(component.freshness as Record<string, unknown>),
            searchedAt: new Date(
              String(
                (component.freshness as Record<string, unknown>).searchedAt,
              ),
            ),
            freshUntil: new Date(
              String(
                (component.freshness as Record<string, unknown>).freshUntil,
              ),
            ),
          }
        : null;
    const incompleteReasons = Array.isArray(component.incompleteReasons)
      ? [...new Set(component.incompleteReasons)]
      : component.incompleteReasons;
    const publicSafetyDecision = projectNoLikenessSafetyDecision(
      component.imageSafetyDecision,
    );
    if (
      (component.component === "METADATA" &&
        component.imageSafetyDecision !== null) ||
      (component.component === "THUMBNAIL" &&
        component.mode === "MANUAL" &&
        component.imageSafetyDecision !== null) ||
      (component.component === "THUMBNAIL" &&
        component.mode === "AI_ASSISTED" &&
        (!publicSafetyDecision ||
          component.imageCandidate?.contractVersion !==
            THUMBNAIL_CONTRACT_VERSION ||
          component.imageCandidate.adapterVersion !==
            LOCAL_NO_LIKENESS_THUMBNAIL_ADAPTER_VERSION ||
          component.imageCandidate.promptBasisVersion !==
            LOCAL_NO_LIKENESS_PROMPT_BASIS_VERSION ||
          !projectNoLikenessSafetyDecision(
            component.imageCandidate.safetyDecision,
          ) ||
          canonicalJson(component.imageCandidate.safetyDecision) !==
            canonicalJson(publicSafetyDecision)))
    )
      return false;
    const expected = hashValues([
      "editorial-approval-component-snapshot-v2",
      component.component,
      component.provenanceId,
      component.mode,
      component.basisVersion,
      component.researchIntentId ?? "",
      component.suggestionSetId ?? "",
      component.imageIntentId ?? "",
      component.imageCandidateId ?? "",
      component.transcriptArtifactId ?? "",
      component.transcriptSha256 ?? "",
      canonicalJson(citations),
      canonicalJson(freshness),
      canonicalJson(publicSafetyDecision),
      component.likeness ?? "",
      component.directCostMicrousd.toString(),
      component.costBasisVersion,
      canonicalJson(incompleteReasons),
    ]);
    if (component.snapshotFingerprint !== expected) return false;
    byComponent.set(component.component, component);
  }
  const metadata = byComponent.get("METADATA");
  const thumbnail = byComponent.get("THUMBNAIL");
  if (!metadata || !thumbnail) return false;
  const expectedEconomics = hashValues([
    "approval-economics-v2",
    economics.workflowMode,
    economics.preparationForegroundMs.toString(),
    economics.finalReviewForegroundMs.toString(),
    metadata.snapshotFingerprint,
    thumbnail.snapshotFingerprint,
    economics.metadataDirectCostMicrousd.toString(),
    economics.evidenceDirectCostMicrousd.toString(),
    economics.thumbnailDirectCostMicrousd.toString(),
    economics.combinedDirectCostMicrousd.toString(),
  ]);
  return economics.snapshotFingerprint === expectedEconomics;
}

function validPersistedPublicCitation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const citation = value as Record<string, unknown>;
  return (
    typeof citation.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(citation.id) &&
    typeof citation.url === "string" &&
    normalizePublicCitationUrl(citation.url) === citation.url &&
    typeof citation.title === "string" &&
    citation.title.length > 0 &&
    citation.title.length <= 300 &&
    typeof citation.publisher === "string" &&
    citation.publisher.length > 0 &&
    citation.publisher.length <= 200 &&
    citation.accessedAt instanceof Date &&
    Number.isFinite(citation.accessedAt.getTime()) &&
    (citation.publishedAt === null ||
      (citation.publishedAt instanceof Date &&
        Number.isFinite(citation.publishedAt.getTime())))
  );
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hashValues(values: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(values.map(String).join("\n"), "utf8")
    .digest("hex");
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
  const contract = exportContractForApproval(row.approvalContractVersion);
  const tuple = [
    "CREATE_EDITORIAL_EXPORT",
    contract,
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

function dispatchKey(
  intentId: string,
  projectId: string,
  contract: string,
): string {
  return createHash("sha256")
    .update(
      ["DISPATCH_EDITORIAL_EXPORT", contract, intentId, projectId].join("|"),
    )
    .digest("hex");
}

function exportContractForApproval(value: string) {
  if (value === EDITORIAL_APPROVAL_CONTRACT) return EDITORIAL_EXPORT_CONTRACT;
  if (value === EDITORIAL_APPROVAL_CONTRACT_V2)
    return EDITORIAL_EXPORT_CONTRACT_V2;
  throw new EditorialExportLineageInvalidError();
}
