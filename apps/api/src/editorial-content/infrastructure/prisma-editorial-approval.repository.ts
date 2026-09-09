import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import type { Prisma } from "../../generated/prisma/client.js";
import { sourceAuthorizationRuntime } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import { isSourceAuthorizationCleared } from "../../projects/domain/source-authorization.js";
import type { EditorialApprovalRepository } from "../application/editorial-approval-repository.port.js";
import {
  APPROVAL_COST_BASIS,
  APPROVAL_METRICS_SCHEMA,
  APPROVAL_TIMESTAMP_BASIS,
  ATTENTION_MEASUREMENT_VERSION,
  calculateApprovalProcessingMetrics,
  EDITORIAL_APPROVAL_CONTRACT,
  EditorialApprovalAuthorizationError,
  EditorialApprovalCandidateConflictError,
  EditorialApprovalCursorInvalidError,
  EditorialApprovalIdempotencyConflictError,
  EditorialApprovalLineageInvalidError,
  EditorialReviewNotFoundError,
  type ApprovalProcessingMetrics,
  type EditorialApprovalBlocker,
  type EditorialApprovalStaleReason,
  type EditorialApprovalView,
  type EditorialReviewView,
} from "../domain/editorial-approval.js";
import { HORIZONTAL_RENDER_CONTRACT } from "../domain/assembly-render.js";
import {
  ASSEMBLY_AUDIO_PROFILE,
  ASSEMBLY_ENCODING_PROFILE,
  ASSEMBLY_SCHEMA_VERSION,
} from "../domain/assembly-recipe.js";
import { montageRightsUsable } from "../domain/montage-asset.js";

const approvalInclude = {
  metrics: true,
  source: { include: { authorizations: true } },
  editorialPackage: { select: { currentRevision: true } },
  editorialPackageRevision: true,
  thumbnailAsset: true,
  assemblyRecipe: { select: { currentRevision: true } },
  recipeRevisionRecord: {
    include: { assetReferences: { include: { asset: true } } },
  },
  assemblyRenderIntent: {
    include: {
      pipelineJob: true,
      result: { include: { artifact: true } },
    },
  },
} satisfies Prisma.EditorialApprovalInclude;

const cutInclude = {
  source: { include: { authorizations: true } },
  segment: true,
  resultArtifact: true,
  attempts: { orderBy: { attemptNumber: "asc" as const } },
  editorialPackage: {
    include: {
      revisions: {
        include: { processingTemplateRevision: true, thumbnailAsset: true },
        orderBy: { revision: "desc" as const },
      },
    },
  },
  assemblyRecipe: {
    include: {
      revisions: {
        include: { assetReferences: { include: { asset: true } } },
        orderBy: { revision: "desc" as const },
      },
    },
  },
  assemblyRenderInputs: {
    include: {
      pipelineJob: {
        include: { attempts: { orderBy: { attemptNumber: "asc" as const } } },
      },
      result: { include: { artifact: true } },
    },
  },
  editorialApprovals: {
    include: approvalInclude,
    orderBy: [{ approvedAt: "desc" as const }, { id: "desc" as const }],
  },
} satisfies Prisma.PipelineJobInclude;

type TransactionClient = Prisma.TransactionClient;
type ApprovalRow = Prisma.EditorialApprovalGetPayload<{
  include: typeof approvalInclude;
}>;
type CutRow = Prisma.PipelineJobGetPayload<{ include: typeof cutInclude }>;

@Injectable()
export class PrismaEditorialApprovalRepository implements EditorialApprovalRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getReview(
    cutPipelineJobId: string,
  ): Promise<EditorialReviewView | null> {
    const cut = await this.findCut(cutPipelineJobId, this.prisma);
    if (!cut) return null;
    return this.buildCurrentReview(cut);
  }

  create(input: Parameters<EditorialApprovalRepository["create"]>[0]) {
    return this.createWithRetry(input, 0);
  }

  private async createWithRetry(
    input: Parameters<EditorialApprovalRepository["create"]>[0],
    conflictCount: number,
  ): Promise<EditorialApprovalView> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const target = await tx.assemblyRenderIntent.findUnique({
            where: { id: input.renderId },
            select: {
              id: true,
              projectId: true,
              sourceId: true,
              sourceVersion: true,
              cutPipelineJobId: true,
            },
          });
          if (!target) throw new EditorialReviewNotFoundError();

          const operation = await tx.editorialOperationRequest.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (operation) {
            if (
              operation.operation !== "CREATE_EDITORIAL_APPROVAL" ||
              !operation.approvalId ||
              operation.exportIntentId ||
              operation.resolvedProjectId !== target.projectId
            ) {
              throw new EditorialApprovalIdempotencyConflictError();
            }
            const approval = await this.findApproval(operation.approvalId, tx);
            if (!approval) throw new EditorialApprovalLineageInvalidError();
            const fingerprint = canonicalApprovalRequestFingerprint({
              renderId: target.id,
              projectId: target.projectId,
              sourceId: target.sourceId,
              sourceVersion: target.sourceVersion,
              cutPipelineJobId: target.cutPipelineJobId,
              editorialPackageId: approval.editorialPackageId,
              editorialPackageRevisionId: approval.editorialPackageRevisionId,
              assemblyRecipeId: approval.assemblyRecipeId,
              recipeRevisionId: approval.recipeRevisionId,
              assemblyRenderResultId: approval.assemblyRenderResultId,
              thumbnailAssetId: approval.thumbnailAssetId,
              editorialRevision: input.editorialRevision,
              candidateFingerprint: input.candidateFingerprint,
              manualAttentionMs: input.manualAttentionMs,
              attentionMeasurementVersion: input.attentionMeasurementVersion,
            });
            if (operation.canonicalRequestFingerprint !== fingerprint) {
              throw new EditorialApprovalIdempotencyConflictError();
            }
            return this.mapApproval(approval);
          }

          const cut = await this.findCut(target.cutPipelineJobId, tx);
          if (!cut) throw new EditorialReviewNotFoundError();
          const review = this.buildCurrentReview(cut);
          if (
            !review.approvable ||
            !review.editorial ||
            !review.recipe ||
            !review.render ||
            !review.processingMetrics ||
            review.render.id !== input.renderId ||
            review.editorial.revision !== input.editorialRevision ||
            review.candidateFingerprint !== input.candidateFingerprint ||
            review.processingMetrics.incompleteReasons.length > 0
          ) {
            throw new EditorialApprovalCandidateConflictError();
          }

          const requestFingerprint = canonicalApprovalRequestFingerprint({
            renderId: input.renderId,
            projectId: review.projectId,
            sourceId: review.sourceId,
            sourceVersion: review.sourceVersion,
            cutPipelineJobId: review.cutPipelineJobId,
            editorialPackageId: review.editorial.packageId,
            editorialPackageRevisionId: review.editorial.revisionId,
            assemblyRecipeId: review.recipe.id,
            recipeRevisionId: review.recipe.revisionId,
            assemblyRenderResultId: review.render.resultId,
            thumbnailAssetId: review.editorial.thumbnail.id,
            editorialRevision: input.editorialRevision,
            candidateFingerprint: input.candidateFingerprint,
            manualAttentionMs: input.manualAttentionMs,
            attentionMeasurementVersion: input.attentionMeasurementVersion,
          });

          let approval = await tx.editorialApproval.findUnique({
            where: {
              editorialPackageRevisionId_assemblyRenderResultId_approvalContractVersion:
                {
                  editorialPackageRevisionId: review.editorial.revisionId,
                  assemblyRenderResultId: review.render.resultId,
                  approvalContractVersion: EDITORIAL_APPROVAL_CONTRACT,
                },
            },
            include: approvalInclude,
          });
          if (approval) {
            if (
              approval.candidateFingerprint !== input.candidateFingerprint ||
              !approval.metrics ||
              approval.metrics.manualAttentionMs !== input.manualAttentionMs ||
              approval.metrics.attentionMeasurementVersion !==
                input.attentionMeasurementVersion
            ) {
              throw new EditorialApprovalCandidateConflictError();
            }
          } else {
            approval = await tx.editorialApproval.create({
              data: {
                id: input.approvalId,
                projectId: review.projectId,
                sourceId: review.sourceId,
                sourceVersion: review.sourceVersion,
                cutPipelineJobId: review.cutPipelineJobId,
                editorialPackageId: review.editorial.packageId,
                editorialPackageRevisionId: review.editorial.revisionId,
                editorialRevision: review.editorial.revision,
                processingTemplateRevisionId:
                  review.editorial.processingTemplateRevisionId,
                thumbnailAssetId: review.editorial.thumbnail.id,
                thumbnailSha256: review.editorial.thumbnail.sha256,
                thumbnailSizeBytes: review.editorial.thumbnail.sizeBytes,
                thumbnailContentType: review.editorial.thumbnail.contentType,
                assemblyRecipeId: review.recipe.id,
                recipeRevisionId: review.recipe.revisionId,
                recipeRevision: review.recipe.revision,
                configurationFingerprint:
                  review.recipe.configurationFingerprint,
                assemblyRenderIntentId: review.render.id,
                assemblyRenderResultId: review.render.resultId,
                renderArtifactId: review.render.artifactId,
                renderArtifactSha256: review.render.artifactSha256,
                renderArtifactSizeBytes: review.render.artifactSizeBytes,
                renderContractVersion: review.render.renderContractVersion,
                approvalContractVersion: EDITORIAL_APPROVAL_CONTRACT,
                candidateFingerprint: input.candidateFingerprint,
                metrics: {
                  create: metricsCreate(
                    review.processingMetrics,
                    input.manualAttentionMs,
                    input.attentionMeasurementVersion,
                  ),
                },
              },
              include: approvalInclude,
            });
          }

          await tx.editorialOperationRequest.create({
            data: {
              id: input.operationRequestId,
              idempotencyKey: input.idempotencyKey,
              operation: "CREATE_EDITORIAL_APPROVAL",
              canonicalRequestFingerprint: requestFingerprint,
              resolvedProjectId: review.projectId,
              approvalId: approval.id,
            },
          });
          return this.mapApproval(approval);
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
        const recovered = await this.recoverCommittedReplay(input);
        if (recovered) return recovered;
        throw new EditorialApprovalIdempotencyConflictError();
      }
      const recovered = await this.recoverCommittedReplay(input);
      if (recovered) return recovered;
      throw error;
    }
  }

  private async recoverCommittedReplay(
    input: Parameters<EditorialApprovalRepository["create"]>[0],
  ): Promise<EditorialApprovalView | null> {
    try {
      const [target, operation] = await Promise.all([
        this.prisma.assemblyRenderIntent.findUnique({
          where: { id: input.renderId },
          select: {
            id: true,
            projectId: true,
            sourceId: true,
            sourceVersion: true,
            cutPipelineJobId: true,
          },
        }),
        this.prisma.editorialOperationRequest.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        }),
      ]);
      if (!target || !operation) return null;
      if (
        operation.operation !== "CREATE_EDITORIAL_APPROVAL" ||
        !operation.approvalId ||
        operation.exportIntentId ||
        operation.resolvedProjectId !== target.projectId
      ) {
        throw new EditorialApprovalIdempotencyConflictError();
      }
      const approval = await this.findApproval(
        operation.approvalId,
        this.prisma,
      );
      if (!approval) throw new EditorialApprovalLineageInvalidError();
      const fingerprint = canonicalApprovalRequestFingerprint({
        renderId: target.id,
        projectId: target.projectId,
        sourceId: target.sourceId,
        sourceVersion: target.sourceVersion,
        cutPipelineJobId: target.cutPipelineJobId,
        editorialPackageId: approval.editorialPackageId,
        editorialPackageRevisionId: approval.editorialPackageRevisionId,
        assemblyRecipeId: approval.assemblyRecipeId,
        recipeRevisionId: approval.recipeRevisionId,
        assemblyRenderResultId: approval.assemblyRenderResultId,
        thumbnailAssetId: approval.thumbnailAssetId,
        editorialRevision: input.editorialRevision,
        candidateFingerprint: input.candidateFingerprint,
        manualAttentionMs: input.manualAttentionMs,
        attentionMeasurementVersion: input.attentionMeasurementVersion,
      });
      if (operation.canonicalRequestFingerprint !== fingerprint)
        throw new EditorialApprovalIdempotencyConflictError();
      return this.mapApproval(approval);
    } catch (recoveryError) {
      if (this.isControlled(recoveryError)) throw recoveryError;
      return null;
    }
  }

  async listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<EditorialApprovalView[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) throw new EditorialReviewNotFoundError();
    const anchor = input.cursor
      ? await this.prisma.editorialApproval.findFirst({
          where: { id: input.cursor, projectId: input.projectId },
          select: { id: true, approvedAt: true },
        })
      : null;
    if (input.cursor && !anchor)
      throw new EditorialApprovalCursorInvalidError();
    const rows = await this.prisma.editorialApproval.findMany({
      where: {
        projectId: input.projectId,
        ...(anchor
          ? {
              OR: [
                { approvedAt: { lt: anchor.approvedAt } },
                { approvedAt: anchor.approvedAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      include: approvalInclude,
      orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
      take: input.limit,
    });
    return rows.map((row) => this.mapApproval(row));
  }

  private findCut(
    id: string,
    client: PrismaService | TransactionClient,
  ): Promise<CutRow | null> {
    return client.pipelineJob.findUnique({
      where: { id },
      include: cutInclude,
    });
  }

  private findApproval(
    id: string,
    client: PrismaService | TransactionClient,
  ): Promise<ApprovalRow | null> {
    return client.editorialApproval.findUnique({
      where: { id },
      include: approvalInclude,
    });
  }

  private buildCurrentReview(cut: CutRow): EditorialReviewView {
    const blockers: EditorialApprovalBlocker[] = [];
    const sourceAuthorizationUsable = this.sourceAuthorizationUsable(cut);
    if (!sourceAuthorizationUsable) blockers.push("AUTHORIZATION_REQUIRED");

    const cutArtifact = cut.resultArtifact;
    if (
      cut.type !== "CUT_SEGMENT" ||
      cut.state !== "READY" ||
      !cut.segment ||
      !cutArtifact ||
      cutArtifact.status !== "READY" ||
      cutArtifact.role !== "CUT_RESULT"
    ) {
      blockers.push("CUT_NOT_READY");
    }
    if (
      cut.source.id !== cut.sourceId ||
      cut.source.projectId !== cut.projectId ||
      cut.source.sourceVersion !== cut.sourceVersion ||
      cut.source.status !== "READY"
    ) {
      blockers.push("LINEAGE_INVALID");
    }
    if (
      cutArtifact &&
      (cutArtifact.projectId !== cut.projectId ||
        cutArtifact.sourceId !== cut.sourceId ||
        cutArtifact.lineageSourceId !== cut.sourceId ||
        cutArtifact.lineageSourceVersion !== cut.sourceVersion ||
        cutArtifact.pipelineJobId !== cut.id ||
        cutArtifact.recipeVersion !== cut.recipeVersion ||
        cutArtifact.sizeBytes <= 0n ||
        !isSha256(cutArtifact.sha256))
    ) {
      blockers.push("LINEAGE_INVALID");
    }

    const packageRevision = cut.editorialPackage?.revisions.find(
      (revision) => revision.revision === cut.editorialPackage?.currentRevision,
    );
    if (!cut.editorialPackage || !packageRevision) {
      blockers.push("EDITORIAL_PACKAGE_MISSING");
    }
    if (
      cut.editorialPackage &&
      cutArtifact &&
      (cut.editorialPackage.projectId !== cut.projectId ||
        cut.editorialPackage.pipelineJobId !== cut.id ||
        cut.editorialPackage.cutResultArtifactId !== cutArtifact.id ||
        cut.editorialPackage.cutResultSha256 !== cutArtifact.sha256 ||
        cut.editorialPackage.cutResultSizeBytes !== cutArtifact.sizeBytes ||
        cut.editorialPackage.cutResultRecipeVersion !== cut.recipeVersion ||
        cut.editorialPackage.lineageSourceId !== cut.sourceId ||
        cut.editorialPackage.lineageSourceVersion !== cut.sourceVersion)
    ) {
      blockers.push("LINEAGE_INVALID");
    }
    if (
      packageRevision &&
      packageRevision.processingTemplateRevision.configurationVersion !==
        "manual-editorial-v1"
    ) {
      blockers.push("EDITORIAL_PROFILE_UNSUPPORTED");
    }
    const tags = stringTags(packageRevision?.tags);
    const thumbnail = packageRevision?.thumbnailAsset ?? null;
    const editorialComplete = Boolean(
      packageRevision?.title?.trim() &&
      packageRevision.description?.trim() &&
      tags &&
      tags.length > 0 &&
      thumbnail &&
      thumbnail.status === "READY",
    );
    if (packageRevision && !editorialComplete)
      blockers.push("EDITORIAL_PACKAGE_INCOMPLETE");
    if (
      packageRevision?.thumbnailAssetId &&
      (!thumbnail ||
        thumbnail.status !== "READY" ||
        thumbnail.type !== "THUMBNAIL")
    ) {
      blockers.push("THUMBNAIL_NOT_READY");
    }
    if (
      thumbnail &&
      (thumbnail.projectId !== cut.projectId ||
        thumbnail.sizeBytes <= 0n ||
        !isSha256(thumbnail.sha256) ||
        !["image/jpeg", "image/png", "image/webp"].includes(
          thumbnail.contentType,
        ))
    ) {
      blockers.push("LINEAGE_INVALID");
    }

    const recipeRevision = cut.assemblyRecipe?.revisions.find(
      (revision) => revision.revision === cut.assemblyRecipe?.currentRevision,
    );
    if (!cut.assemblyRecipe || !recipeRevision)
      blockers.push("ASSEMBLY_RECIPE_MISSING");
    if (
      cut.assemblyRecipe &&
      cutArtifact &&
      (cut.assemblyRecipe.projectId !== cut.projectId ||
        cut.assemblyRecipe.pipelineJobId !== cut.id ||
        cut.assemblyRecipe.cutResultArtifactId !== cutArtifact.id ||
        cut.assemblyRecipe.cutResultSha256 !== cutArtifact.sha256 ||
        cut.assemblyRecipe.cutResultSizeBytes !== cutArtifact.sizeBytes ||
        cut.assemblyRecipe.cutResultRecipeVersion !== cut.recipeVersion ||
        cut.assemblyRecipe.lineageSourceId !== cut.sourceId ||
        cut.assemblyRecipe.lineageSourceVersion !== cut.sourceVersion)
    ) {
      blockers.push("LINEAGE_INVALID");
    }
    if (
      recipeRevision &&
      (recipeRevision.schemaVersion !== ASSEMBLY_SCHEMA_VERSION ||
        recipeRevision.audioProfileVersion !== ASSEMBLY_AUDIO_PROFILE ||
        recipeRevision.encodingProfileVersion !== ASSEMBLY_ENCODING_PROFILE ||
        !isSha256(recipeRevision.configurationFingerprint))
    ) {
      blockers.push("ASSEMBLY_PROFILE_UNSUPPORTED");
    }
    if (
      recipeRevision &&
      recipeRevision.assetReferences.some(
        (reference) =>
          reference.asset.id !== reference.assetId ||
          reference.asset.projectId !== cut.projectId ||
          reference.asset.sourceId !== cut.sourceId ||
          reference.asset.sourceVersion !== cut.sourceVersion ||
          reference.asset.status !== "READY" ||
          reference.asset.revision !== reference.assetRevision ||
          reference.asset.sha256 !== reference.assetSha256 ||
          reference.asset.sizeBytes !== reference.assetSizeBytes ||
          reference.asset.kind !== reference.assetKind ||
          reference.asset.durationMs !== reference.assetDurationMs,
      )
    ) {
      blockers.push("LINEAGE_INVALID");
    }
    if (
      recipeRevision &&
      recipeRevision.assetReferences.some(
        (reference) =>
          !montageRightsUsable(
            reference.asset,
            sourceAuthorizationRuntime().policy,
          ),
      )
    ) {
      blockers.push("ASSET_RIGHTS_REQUIRED");
    }

    const render = recipeRevision
      ? cut.assemblyRenderInputs.find(
          (candidate) =>
            candidate.recipeRevisionId === recipeRevision.id &&
            candidate.renderContractVersion === HORIZONTAL_RENDER_CONTRACT,
        )
      : undefined;
    const renderReady = Boolean(
      render?.pipelineJob?.state === "READY" &&
      render.result &&
      render.result.artifact.status === "READY" &&
      render.result.artifact.role === "HORIZONTAL_ASSEMBLY_RESULT",
    );
    if (!renderReady) blockers.push("ASSEMBLY_RENDER_NOT_READY");
    if (render && render.renderContractVersion !== HORIZONTAL_RENDER_CONTRACT)
      blockers.push("RENDER_CONTRACT_UNSUPPORTED");
    if (
      render?.pipelineJob &&
      render.result &&
      (render.projectId !== cut.projectId ||
        render.sourceId !== cut.sourceId ||
        render.sourceVersion !== cut.sourceVersion ||
        render.cutPipelineJobId !== cut.id ||
        render.assemblyRecipeId !== cut.assemblyRecipe?.id ||
        render.configurationFingerprint !==
          recipeRevision?.configurationFingerprint ||
        render.pipelineJob.type !== "ASSEMBLE_HORIZONTAL" ||
        render.pipelineJob.assemblyRenderIntentId !== render.id ||
        render.result.renderIntentId !== render.id ||
        render.result.artifact.id !== render.result.artifactId ||
        render.result.artifact.projectId !== cut.projectId ||
        render.result.artifact.lineageSourceId !== cut.sourceId ||
        render.result.artifact.lineageSourceVersion !== cut.sourceVersion ||
        render.result.artifact.pipelineJobId !== render.pipelineJob.id ||
        render.result.artifact.recipeVersion !== HORIZONTAL_RENDER_CONTRACT ||
        render.result.artifact.contentType !== "video/mp4" ||
        !isSha256(render.result.artifact.sha256) ||
        render.result.artifact.sizeBytes <= 0n)
    ) {
      blockers.push("LINEAGE_INVALID");
    }

    const processingMetrics =
      renderReady && render?.pipelineJob && render.result
        ? calculateApprovalProcessingMetrics({
            cut: {
              queuedAt: cut.queuedAt,
              finishedAt: cut.finishedAt,
              attempts: cut.attempts,
            },
            assembly: {
              queuedAt: render.pipelineJob.queuedAt,
              finishedAt: render.pipelineJob.finishedAt,
              attempts: render.pipelineJob.attempts,
            },
            outputDurationMs: render.result.durationMs,
            outputBytes: render.result.artifact.sizeBytes,
          })
        : null;
    if (processingMetrics?.incompleteReasons.length)
      blockers.push("PROCESSING_METRICS_INCOMPLETE");

    const editorial =
      packageRevision &&
      cut.editorialPackage &&
      packageRevision.title !== null &&
      packageRevision.description !== null &&
      tags &&
      thumbnail
        ? {
            packageId: cut.editorialPackage.id,
            revisionId: packageRevision.id,
            revision: packageRevision.revision,
            processingTemplateRevisionId:
              packageRevision.processingTemplateRevisionId,
            title: packageRevision.title,
            description: packageRevision.description,
            tags,
            thumbnail: {
              id: thumbnail.id,
              sha256: thumbnail.sha256,
              sizeBytes: thumbnail.sizeBytes,
              contentType: thumbnail.contentType,
              filename: thumbnail.originalFilename,
              contentUrl: `/api/v1/projects/${cut.projectId}/editorial-assets/${thumbnail.id}/content`,
            },
          }
        : null;
    const recipe =
      recipeRevision && cut.assemblyRecipe
        ? {
            id: cut.assemblyRecipe.id,
            revisionId: recipeRevision.id,
            revision: recipeRevision.revision,
            configurationFingerprint: recipeRevision.configurationFingerprint,
          }
        : null;
    const renderView =
      renderReady && render?.result
        ? {
            id: render.id,
            resultId: render.result.id,
            artifactId: render.result.artifact.id,
            artifactSha256: render.result.artifact.sha256,
            artifactSizeBytes: render.result.artifact.sizeBytes,
            renderContractVersion: render.renderContractVersion,
            durationMs: render.result.durationMs,
            contentUrl: `/api/v1/assembly-renders/${render.id}/content`,
          }
        : null;
    const candidateFingerprint =
      editorial && recipe && renderView && cutArtifact
        ? candidateFingerprintFor({
            projectId: cut.projectId,
            sourceId: cut.sourceId,
            sourceVersion: cut.sourceVersion,
            cutPipelineJobId: cut.id,
            cutResultArtifactId: cutArtifact.id,
            cutResultSha256: cutArtifact.sha256,
            cutResultSizeBytes: cutArtifact.sizeBytes,
            editorial,
            recipe,
            render: renderView,
          })
        : null;

    const approvals = cut.editorialApprovals.map((value) =>
      this.mapApproval(value),
    );
    return {
      projectId: cut.projectId,
      sourceId: cut.sourceId,
      sourceVersion: cut.sourceVersion,
      cutPipelineJobId: cut.id,
      cutResultArtifactId: cutArtifact?.id ?? null,
      editorial,
      recipe,
      render: renderView,
      candidateFingerprint,
      approvable: blockers.length === 0 && candidateFingerprint !== null,
      blockers: unique(blockers),
      processingMetrics,
      currentApproval:
        approvals.find(
          (approval) =>
            approval.state === "CURRENT" &&
            approval.candidateFingerprint === candidateFingerprint,
        ) ?? null,
      latestApproval: approvals[0] ?? null,
    };
  }

  private mapApproval(row: ApprovalRow): EditorialApprovalView {
    if (!row.metrics) throw new EditorialApprovalLineageInvalidError();
    const staleReasons = this.staleReasons(row);
    return {
      id: row.id,
      projectId: row.projectId,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
      cutPipelineJobId: row.cutPipelineJobId,
      editorialPackageId: row.editorialPackageId,
      editorialPackageRevisionId: row.editorialPackageRevisionId,
      editorialRevision: row.editorialRevision,
      processingTemplateRevisionId: row.processingTemplateRevisionId,
      thumbnailAssetId: row.thumbnailAssetId,
      thumbnailSha256: row.thumbnailSha256,
      thumbnailSizeBytes: row.thumbnailSizeBytes,
      thumbnailContentType: row.thumbnailContentType,
      assemblyRecipeId: row.assemblyRecipeId,
      recipeRevisionId: row.recipeRevisionId,
      recipeRevision: row.recipeRevision,
      configurationFingerprint: row.configurationFingerprint,
      assemblyRenderIntentId: row.assemblyRenderIntentId,
      assemblyRenderResultId: row.assemblyRenderResultId,
      renderArtifactId: row.renderArtifactId,
      renderArtifactSha256: row.renderArtifactSha256,
      renderArtifactSizeBytes: row.renderArtifactSizeBytes,
      renderContractVersion: row.renderContractVersion,
      approvalContractVersion: EDITORIAL_APPROVAL_CONTRACT,
      candidateFingerprint: row.candidateFingerprint,
      approvedAt: row.approvedAt,
      state: staleReasons.length === 0 ? "CURRENT" : "STALE",
      staleReasons,
      metrics: {
        metricsSchemaVersion: APPROVAL_METRICS_SCHEMA,
        timestampBasisVersion: APPROVAL_TIMESTAMP_BASIS,
        cut: {
          initialQueueWaitMs: safeNumber(row.metrics.cutInitialQueueWaitMs),
          retryWaitMs: safeNumber(row.metrics.cutRetryWaitMs),
          firstStartToFinishMs: safeNumber(row.metrics.cutFirstStartToFinishMs),
          activeAttemptMs: safeNumber(row.metrics.cutActiveAttemptMs),
          attemptCount: row.metrics.cutAttemptCount,
          retryCount: row.metrics.cutRetryCount,
        },
        assembly: {
          initialQueueWaitMs: safeNumber(
            row.metrics.assemblyInitialQueueWaitMs,
          ),
          retryWaitMs: safeNumber(row.metrics.assemblyRetryWaitMs),
          firstStartToFinishMs: safeNumber(
            row.metrics.assemblyFirstStartToFinishMs,
          ),
          activeAttemptMs: safeNumber(row.metrics.assemblyActiveAttemptMs),
          attemptCount: row.metrics.assemblyAttemptCount,
          retryCount: row.metrics.assemblyRetryCount,
        },
        cutToAssemblyReadyElapsedMs: safeNumber(
          row.metrics.cutToAssemblyReadyElapsedMs,
        ),
        outputDurationMs: row.metrics.outputDurationMs,
        outputBytes: row.metrics.outputBytes,
        manualAttentionMs: row.metrics.manualAttentionMs,
        attentionMeasurementVersion: ATTENTION_MEASUREMENT_VERSION,
        directProviderCostMinor: 0,
        costCurrency: "RUB",
        costBasisVersion: APPROVAL_COST_BASIS,
        incompleteReasons: parseIncompleteReasons(
          row.metrics.incompleteReasons,
        ),
      },
    };
  }

  private staleReasons(row: ApprovalRow): EditorialApprovalStaleReason[] {
    const reasons: EditorialApprovalStaleReason[] = [];
    if (row.approvalContractVersion !== EDITORIAL_APPROVAL_CONTRACT)
      reasons.push("APPROVAL_CONTRACT_UNSUPPORTED");
    if (row.renderContractVersion !== HORIZONTAL_RENDER_CONTRACT)
      reasons.push("RENDER_CONTRACT_UNSUPPORTED");
    if (row.editorialPackage.currentRevision !== row.editorialRevision)
      reasons.push("EDITORIAL_REVISION_CHANGED");
    if (row.assemblyRecipe.currentRevision !== row.recipeRevision)
      reasons.push("ASSEMBLY_RECIPE_REVISION_CHANGED");
    const render = row.assemblyRenderIntent;
    if (
      render.pipelineJob?.state !== "READY" ||
      !render.result ||
      render.result.artifact.status !== "READY"
    )
      reasons.push("RENDER_RESULT_NOT_READY");
    if (
      row.thumbnailAsset.status !== "READY" ||
      row.thumbnailAsset.sha256 !== row.thumbnailSha256 ||
      row.thumbnailAsset.sizeBytes !== row.thumbnailSizeBytes ||
      row.thumbnailAsset.contentType !== row.thumbnailContentType
    )
      reasons.push("THUMBNAIL_NOT_READY");
    if (!this.sourceAuthorizationUsable(row))
      reasons.push("AUTHORIZATION_REQUIRED");
    if (
      row.recipeRevisionRecord.assetReferences.some(
        (reference) =>
          !montageRightsUsable(
            reference.asset,
            sourceAuthorizationRuntime().policy,
          ),
      )
    )
      reasons.push("ASSET_RIGHTS_REQUIRED");
    if (
      row.editorialPackageRevision.id !== row.editorialPackageRevisionId ||
      row.editorialPackageRevision.packageId !== row.editorialPackageId ||
      row.editorialPackageRevision.revision !== row.editorialRevision ||
      row.editorialPackageRevision.processingTemplateRevisionId !==
        row.processingTemplateRevisionId ||
      row.editorialPackageRevision.thumbnailAssetId !== row.thumbnailAssetId ||
      row.recipeRevisionRecord.id !== row.recipeRevisionId ||
      row.recipeRevisionRecord.recipeId !== row.assemblyRecipeId ||
      row.recipeRevisionRecord.revision !== row.recipeRevision ||
      row.recipeRevisionRecord.configurationFingerprint !==
        row.configurationFingerprint ||
      render.id !== row.assemblyRenderIntentId ||
      render.projectId !== row.projectId ||
      render.sourceId !== row.sourceId ||
      render.sourceVersion !== row.sourceVersion ||
      render.cutPipelineJobId !== row.cutPipelineJobId ||
      render.result?.id !== row.assemblyRenderResultId ||
      render.result?.artifact.id !== row.renderArtifactId ||
      render.result?.artifact.sha256 !== row.renderArtifactSha256 ||
      render.result?.artifact.sizeBytes !== row.renderArtifactSizeBytes
    )
      reasons.push("LINEAGE_INVALID");
    return unique(reasons);
  }

  private sourceAuthorizationUsable(row: {
    sourceVersion: number;
    source: {
      sourceVersion: number;
      status: string;
      authorizations: Array<{
        sourceVersion: number;
        status: string;
        basis: string | null;
        declarationVersion: string | null;
        decidedAt: Date | null;
      }>;
    };
  }): boolean {
    if (
      row.source.status !== "READY" ||
      row.source.sourceVersion !== row.sourceVersion
    )
      return false;
    const decision = row.source.authorizations.find(
      (value) => value.sourceVersion === row.sourceVersion,
    );
    return isSourceAuthorizationCleared(
      decision as Parameters<typeof isSourceAuthorizationCleared>[0],
      row.sourceVersion,
      sourceAuthorizationRuntime().policy,
    );
  }

  private isControlled(error: unknown): boolean {
    return (
      error instanceof EditorialReviewNotFoundError ||
      error instanceof EditorialApprovalIdempotencyConflictError ||
      error instanceof EditorialApprovalCandidateConflictError ||
      error instanceof EditorialApprovalAuthorizationError ||
      error instanceof EditorialApprovalLineageInvalidError
    );
  }

  private isUniqueConstraint(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002",
    );
  }

  private isTransactionConflict(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2034",
    );
  }
}

function candidateFingerprintFor(input: {
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  cutPipelineJobId: string;
  cutResultArtifactId: string;
  cutResultSha256: string;
  cutResultSizeBytes: bigint;
  editorial: NonNullable<EditorialReviewView["editorial"]>;
  recipe: NonNullable<EditorialReviewView["recipe"]>;
  render: NonNullable<EditorialReviewView["render"]>;
}): string {
  return hashFixed([
    "editorial-review-candidate-v1",
    input.projectId,
    input.sourceId,
    input.sourceVersion,
    input.cutPipelineJobId,
    input.cutResultArtifactId,
    input.cutResultSha256,
    input.cutResultSizeBytes,
    input.editorial.packageId,
    input.editorial.revisionId,
    input.editorial.revision,
    input.editorial.processingTemplateRevisionId,
    input.editorial.thumbnail.id,
    input.editorial.thumbnail.sha256,
    input.editorial.thumbnail.sizeBytes,
    input.editorial.thumbnail.contentType,
    input.recipe.id,
    input.recipe.revisionId,
    input.recipe.revision,
    input.recipe.configurationFingerprint,
    input.render.id,
    input.render.resultId,
    input.render.artifactId,
    input.render.artifactSha256,
    input.render.artifactSizeBytes,
    input.render.renderContractVersion,
    EDITORIAL_APPROVAL_CONTRACT,
  ]);
}

function canonicalApprovalRequestFingerprint(input: {
  renderId: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  cutPipelineJobId: string;
  editorialPackageId: string;
  editorialPackageRevisionId: string;
  assemblyRecipeId: string;
  recipeRevisionId: string;
  assemblyRenderResultId: string;
  thumbnailAssetId: string;
  editorialRevision: number;
  candidateFingerprint: string;
  manualAttentionMs: number;
  attentionMeasurementVersion: string;
}): string {
  return hashFixed([
    "CREATE_EDITORIAL_APPROVAL",
    EDITORIAL_APPROVAL_CONTRACT,
    input.renderId,
    input.projectId,
    input.sourceId,
    input.sourceVersion,
    input.cutPipelineJobId,
    input.editorialPackageId,
    input.editorialPackageRevisionId,
    input.assemblyRecipeId,
    input.recipeRevisionId,
    input.assemblyRenderResultId,
    input.thumbnailAssetId,
    input.editorialRevision,
    input.candidateFingerprint,
    input.manualAttentionMs,
    input.attentionMeasurementVersion,
  ]);
}

function hashFixed(values: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(values.map((value) => String(value)).join("\n"), "utf8")
    .digest("hex");
}

function metricsCreate(
  metrics: ApprovalProcessingMetrics,
  manualAttentionMs: number,
  attentionMeasurementVersion: string,
) {
  return {
    metricsSchemaVersion: metrics.metricsSchemaVersion,
    timestampBasisVersion: metrics.timestampBasisVersion,
    cutInitialQueueWaitMs: bigintOrNull(metrics.cut.initialQueueWaitMs),
    cutRetryWaitMs: bigintOrNull(metrics.cut.retryWaitMs),
    cutFirstStartToFinishMs: bigintOrNull(metrics.cut.firstStartToFinishMs),
    cutActiveAttemptMs: bigintOrNull(metrics.cut.activeAttemptMs),
    cutAttemptCount: metrics.cut.attemptCount,
    cutRetryCount: metrics.cut.retryCount,
    assemblyInitialQueueWaitMs: bigintOrNull(
      metrics.assembly.initialQueueWaitMs,
    ),
    assemblyRetryWaitMs: bigintOrNull(metrics.assembly.retryWaitMs),
    assemblyFirstStartToFinishMs: bigintOrNull(
      metrics.assembly.firstStartToFinishMs,
    ),
    assemblyActiveAttemptMs: bigintOrNull(metrics.assembly.activeAttemptMs),
    assemblyAttemptCount: metrics.assembly.attemptCount,
    assemblyRetryCount: metrics.assembly.retryCount,
    cutToAssemblyReadyElapsedMs: bigintOrNull(
      metrics.cutToAssemblyReadyElapsedMs,
    ),
    outputDurationMs: metrics.outputDurationMs,
    outputBytes: metrics.outputBytes,
    manualAttentionMs,
    attentionMeasurementVersion,
    directProviderCostMinor: metrics.directProviderCostMinor,
    costCurrency: metrics.costCurrency,
    costBasisVersion: metrics.costBasisVersion,
    incompleteReasons: metrics.incompleteReasons,
  };
}

function bigintOrNull(value: number | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function safeNumber(value: bigint | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new EditorialApprovalLineageInvalidError();
  return number;
}

function stringTags(
  value: Prisma.JsonValue | null | undefined,
): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item) => typeof item === "string") ? value : null;
}

function parseIncompleteReasons(value: Prisma.JsonValue) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new EditorialApprovalLineageInvalidError();
  return value as EditorialApprovalView["metrics"]["incompleteReasons"];
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
