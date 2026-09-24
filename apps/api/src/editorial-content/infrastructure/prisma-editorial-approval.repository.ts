import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
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
import {
  EDITORIAL_INTEGRATED_REVIEW_ENABLED,
  type EditorialApprovalRepository,
} from "../application/editorial-approval-repository.port.js";
import {
  APPROVAL_COST_BASIS,
  APPROVAL_METRICS_SCHEMA,
  APPROVAL_TIMESTAMP_BASIS,
  ATTENTION_MEASUREMENT_VERSION,
  APPROVAL_ECONOMICS_SCHEMA_V2,
  calculateApprovalProcessingMetrics,
  EDITORIAL_APPROVAL_CONTRACT,
  EDITORIAL_APPROVAL_CONTRACT_V2,
  EDITORIAL_REVIEW_CONTRACT_V2,
  OPERATOR_ATTENTION_SCHEMA_V2,
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
  type EditorialReviewComponentSummary,
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
  componentSnapshots: {
    orderBy: { component: "asc" as const },
    include: { provenance: true, suggestionSet: true, imageCandidate: true },
  },
  economicsV2: true,
  source: { include: { authorizations: true } },
  editorialPackage: { select: { currentRevision: true } },
  editorialPackageRevision: { include: { componentProvenance: true } },
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
        include: {
          processingTemplateRevision: true,
          thumbnailAsset: true,
          componentProvenance: {
            include: {
              researchIntent: {
                include: {
                  citations: { orderBy: { ordinal: "asc" as const } },
                  suggestionSet: true,
                  transcriptIntent: { include: { artifact: true } },
                },
              },
              suggestionSet: true,
              imageIntent: { include: { candidate: true } },
              imageCandidate: true,
            },
          },
        },
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
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(EDITORIAL_INTEGRATED_REVIEW_ENABLED)
    private readonly integratedReviewEnabled: boolean = false,
  ) {}

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
              approvalContractVersion: input.approvalContractVersion,
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
              attention: input.attention,
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
          if (
            input.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT &&
            review.workflowMode !== "MANUAL"
          )
            throw new EditorialApprovalCandidateConflictError();
          const attention = approvalAttention(input);

          const requestFingerprint = canonicalApprovalRequestFingerprint({
            approvalContractVersion: input.approvalContractVersion,
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
            attention: input.attention,
          });

          let approval = await tx.editorialApproval.findUnique({
            where: {
              editorialPackageRevisionId_assemblyRenderResultId_approvalContractVersion:
                {
                  editorialPackageRevisionId: review.editorial.revisionId,
                  assemblyRenderResultId: review.render.resultId,
                  approvalContractVersion: input.approvalContractVersion,
                },
            },
            include: approvalInclude,
          });
          if (approval) {
            if (
              approval.candidateFingerprint !== input.candidateFingerprint ||
              !approval.metrics ||
              approval.metrics.manualAttentionMs !== attention.totalMs ||
              approval.metrics.attentionMeasurementVersion !==
                attention.version ||
              (input.approvalContractVersion ===
                EDITORIAL_APPROVAL_CONTRACT_V2 &&
                (approval.economicsV2?.preparationForegroundMs !==
                  attention.preparationMs ||
                  approval.economicsV2.finalReviewForegroundMs !==
                    attention.finalReviewMs))
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
                approvalContractVersion: input.approvalContractVersion,
                candidateFingerprint: input.candidateFingerprint,
                metrics: {
                  create: metricsCreate(
                    review.processingMetrics,
                    attention.totalMs,
                    attention.version,
                  ),
                },
                ...(input.approvalContractVersion ===
                EDITORIAL_APPROVAL_CONTRACT_V2
                  ? v2ApprovalSnapshotCreate(review, attention)
                  : {}),
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
        approvalContractVersion: input.approvalContractVersion,
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
        attention: input.attention,
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

    const metadataSummary = this.componentSummary(
      packageRevision?.componentProvenance ?? [],
      "METADATA",
      cut,
      thumbnail,
    );
    const thumbnailSummary = this.componentSummary(
      packageRevision?.componentProvenance ?? [],
      "THUMBNAIL",
      cut,
      thumbnail,
    );
    if (
      metadataSummary.incompleteReasons.length > 0 ||
      thumbnailSummary.incompleteReasons.length > 0
    ) {
      // Legacy revisions without explicit provenance remain approvable only
      // through the v1 path while integrated-v2 admission is disabled.
      if (this.integratedReviewEnabled)
        blockers.push("EDITORIAL_PROFILE_UNSUPPORTED");
    }
    const workflowMode = workflowModeFor(
      metadataSummary.mode,
      thumbnailSummary.mode,
    );

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
    const v2CandidateFingerprint =
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
            metadataSnapshotFingerprint: metadataSummary.snapshotFingerprint,
            thumbnailSnapshotFingerprint: thumbnailSummary.snapshotFingerprint,
            workflowMode,
          })
        : null;
    const legacyCandidateFingerprint =
      editorial && recipe && renderView && cutArtifact
        ? legacyCandidateFingerprintFor({
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
    const candidateFingerprint = this.integratedReviewEnabled
      ? v2CandidateFingerprint
      : legacyCandidateFingerprint;

    const approvals = cut.editorialApprovals.map((value) =>
      this.mapApproval(value),
    );
    return {
      reviewContractVersion: EDITORIAL_REVIEW_CONTRACT_V2,
      integratedReviewEnabled: this.integratedReviewEnabled,
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
      workflowMode,
      components: {
        metadata: metadataSummary,
        thumbnail: thumbnailSummary,
      },
      economicsPreview: {
        processingMetrics,
        metadataDirectCostMicrousd: metadataSummary.directCostMicrousd,
        evidenceDirectCostMicrousd: 0n,
        thumbnailDirectCostMicrousd: thumbnailSummary.directCostMicrousd,
        combinedDirectCostMicrousd:
          metadataSummary.directCostMicrousd +
          thumbnailSummary.directCostMicrousd,
        currency: "USD",
        unit: "MICRO",
        incompleteReasons: unique([
          ...metadataSummary.incompleteReasons,
          ...thumbnailSummary.incompleteReasons,
        ]),
      },
      currentApproval:
        approvals.find(
          (approval) =>
            approval.state === "CURRENT" &&
            approval.candidateFingerprint ===
              (approval.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT
                ? legacyCandidateFingerprint
                : v2CandidateFingerprint),
        ) ?? null,
      latestApproval: approvals[0] ?? null,
    };
  }

  private componentSummary(
    rows: NonNullable<
      CutRow["editorialPackage"]
    >["revisions"][number]["componentProvenance"],
    component: "METADATA" | "THUMBNAIL",
    cut: CutRow,
    selectedThumbnail:
      | NonNullable<
          CutRow["editorialPackage"]
        >["revisions"][number]["thumbnailAsset"]
      | null,
  ): EditorialReviewComponentSummary {
    const matching = rows.filter((row) => row.component === component);
    const row = matching[0];
    const incompleteReasons: string[] = [];
    if (matching.length !== 1 || !row) {
      incompleteReasons.push("COMPONENT_PROVENANCE_MISSING");
      return manualComponentSummary(component, incompleteReasons);
    }
    if (row.mode === "MANUAL") {
      if (
        row.researchIntentId ||
        row.suggestionSetId ||
        row.imageIntentId ||
        row.imageCandidateId
      )
        incompleteReasons.push("MANUAL_PROVENANCE_HAS_AI_LINEAGE");
      return finalizeComponentSummary({
        component,
        provenanceId: row.id,
        mode: "MANUAL",
        basisVersion: row.basisVersion,
        researchIntentId: null,
        suggestionSetId: null,
        imageIntentId: null,
        imageCandidateId: null,
        transcriptArtifactId: null,
        transcriptSha256: null,
        citations: [],
        research: null,
        imageSafetyDecision: null,
        likeness: null,
        directCostMicrousd: 0n,
        costBasisVersion: row.basisVersion,
        incompleteReasons,
      });
    }
    if (component === "METADATA") {
      const intent = row.researchIntent;
      const suggestion = row.suggestionSet;
      if (
        !intent ||
        !suggestion ||
        intent.id !== row.researchIntentId ||
        suggestion.id !== row.suggestionSetId ||
        suggestion.intentId !== intent.id ||
        intent.state !== "READY" ||
        intent.projectId !== cut.projectId ||
        intent.sourceId !== cut.sourceId ||
        intent.sourceVersion !== cut.sourceVersion ||
        intent.cutPipelineJobId !== cut.id ||
        intent.cutResultArtifactId !== cut.resultArtifact?.id ||
        intent.transcriptIntent.projectId !== cut.projectId ||
        intent.transcriptIntent.sourceId !== cut.sourceId ||
        intent.transcriptIntent.sourceVersion !== cut.sourceVersion ||
        intent.transcriptIntent.cutPipelineJobId !== cut.id ||
        intent.transcriptIntent.cutResultArtifactId !==
          cut.resultArtifact?.id ||
        intent.transcriptIntent.cutResultSha256 !==
          cut.resultArtifact?.sha256 ||
        intent.transcriptIntent.cutResultSizeBytes !==
          cut.resultArtifact?.sizeBytes ||
        intent.transcriptIntent.creatorProfileRevisionId !==
          intent.creatorProfileRevisionId ||
        intent.transcriptIntent.sourceContextRevisionId !==
          intent.sourceContextRevisionId ||
        intent.transcriptIntent.cutPromptRevisionId !==
          intent.cutPromptRevisionId
      )
        incompleteReasons.push("METADATA_LINEAGE_INVALID");
      const citations = selectSuggestionCitations(
        (intent?.citations ?? []).map((citation) => ({
          id: citation.id,
          url: citation.url,
          title: citation.title,
          publisher: citation.publisher,
          publishedAt: citation.publishedAt,
          accessedAt: citation.accessedAt,
        })),
        suggestion?.citationIds,
      );
      if (!citations) {
        incompleteReasons.push("CITATIONS_INVALID");
        incompleteReasons.push("CITATION_LINEAGE_INVALID");
      }
      const transcript = intent?.transcriptIntent.artifact ?? null;
      if (
        !transcript ||
        transcript.id !== intent?.transcriptArtifactId ||
        transcript.intentId !== intent?.transcriptIntentId ||
        intent?.transcriptIntent.id !== intent?.transcriptIntentId ||
        transcript.sha256 !== intent?.transcriptSha256 ||
        !isSha256(transcript.sha256)
      )
        incompleteReasons.push("TRANSCRIPT_LINEAGE_INVALID");
      const freshness = intent
        ? {
            searchedAt: intent.searchedAt,
            freshUntil: intent.freshUntil,
            freshness:
              intent.freshUntil.getTime() >= Date.now()
                ? ("CURRENT" as const)
                : ("EXPIRED" as const),
          }
        : null;
      if (freshness?.freshness === "EXPIRED")
        incompleteReasons.push("RESEARCH_EXPIRED");
      return finalizeComponentSummary({
        component,
        provenanceId: row.id,
        mode: row.mode,
        basisVersion: row.basisVersion,
        researchIntentId: intent?.id ?? null,
        suggestionSetId: suggestion?.id ?? null,
        imageIntentId: null,
        imageCandidateId: null,
        transcriptArtifactId: transcript?.id ?? null,
        transcriptSha256: transcript?.sha256 ?? null,
        citations: citations ?? [],
        research: freshness,
        imageSafetyDecision: null,
        likeness: null,
        directCostMicrousd: suggestion?.directCostMicrousd ?? 0n,
        costBasisVersion:
          suggestion?.costBasisVersion ?? "unknown-metadata-cost-basis",
        incompleteReasons,
      });
    }
    const intent = row.imageIntent;
    const candidate = row.imageCandidate;
    const publicSafetyDecision = projectNoLikenessSafetyDecision(
      candidate?.safetyDecision,
    );
    if (
      row.mode !== "AI_ASSISTED" ||
      !intent ||
      !candidate ||
      intent.id !== row.imageIntentId ||
      candidate.id !== row.imageCandidateId ||
      candidate.intentId !== intent.id ||
      intent.state !== "READY" ||
      intent.projectId !== cut.projectId ||
      intent.sourceId !== cut.sourceId ||
      intent.sourceVersion !== cut.sourceVersion ||
      intent.cutPipelineJobId !== cut.id ||
      intent.cutResultArtifactId !== cut.resultArtifact?.id ||
      intent.cutResultSha256 !== cut.resultArtifact?.sha256 ||
      intent.cutResultSizeBytes !== cut.resultArtifact?.sizeBytes ||
      !selectedThumbnail ||
      selectedThumbnail.status !== "READY" ||
      candidate.objectKey !== selectedThumbnail.objectKey ||
      candidate.sha256 !== selectedThumbnail.sha256 ||
      candidate.sizeBytes !== selectedThumbnail.sizeBytes ||
      candidate.contentType !== selectedThumbnail.contentType ||
      candidate.width !== selectedThumbnail.width ||
      candidate.height !== selectedThumbnail.height ||
      candidate.likeness !== "NONE" ||
      candidate.contractVersion !== THUMBNAIL_CONTRACT_VERSION ||
      candidate.adapterVersion !==
        LOCAL_NO_LIKENESS_THUMBNAIL_ADAPTER_VERSION ||
      candidate.promptBasisVersion !==
        LOCAL_NO_LIKENESS_PROMPT_BASIS_VERSION ||
      !publicSafetyDecision
    )
      incompleteReasons.push("THUMBNAIL_LINEAGE_INVALID");
    return finalizeComponentSummary({
      component,
      provenanceId: row.id,
      mode: row.mode,
      basisVersion: row.basisVersion,
      researchIntentId: null,
      suggestionSetId: null,
      imageIntentId: intent?.id ?? null,
      imageCandidateId: candidate?.id ?? null,
      transcriptArtifactId: null,
      transcriptSha256: null,
      citations: [],
      research: null,
      imageSafetyDecision: publicSafetyDecision,
      likeness: candidate?.likeness ?? null,
      directCostMicrousd: candidate?.directCostMicrousd ?? 0n,
      costBasisVersion:
        candidate?.costBasisVersion ?? "unknown-thumbnail-cost-basis",
      incompleteReasons,
    });
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
      approvalContractVersion:
        row.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT_V2
          ? EDITORIAL_APPROVAL_CONTRACT_V2
          : EDITORIAL_APPROVAL_CONTRACT,
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
        attentionMeasurementVersion:
          row.metrics.attentionMeasurementVersion ===
          OPERATOR_ATTENTION_SCHEMA_V2
            ? OPERATOR_ATTENTION_SCHEMA_V2
            : ATTENTION_MEASUREMENT_VERSION,
        directProviderCostMinor: 0,
        costCurrency: "RUB",
        costBasisVersion: APPROVAL_COST_BASIS,
        incompleteReasons: parseIncompleteReasons(
          row.metrics.incompleteReasons,
        ),
      },
      componentSnapshots: row.componentSnapshots.map((snapshot) =>
        mapPersistedComponentSnapshot(snapshot),
      ),
      economicsV2: row.economicsV2
        ? {
            schemaVersion: APPROVAL_ECONOMICS_SCHEMA_V2,
            workflowMode: row.economicsV2.workflowMode,
            attention: {
              schemaVersion: OPERATOR_ATTENTION_SCHEMA_V2,
              preparationForegroundMs: row.economicsV2.preparationForegroundMs,
              finalReviewForegroundMs: row.economicsV2.finalReviewForegroundMs,
              totalOperatorAttentionMs:
                row.economicsV2.totalOperatorAttentionMs,
            },
            metadataDirectCostMicrousd:
              row.economicsV2.metadataDirectCostMicrousd,
            evidenceDirectCostMicrousd:
              row.economicsV2.evidenceDirectCostMicrousd,
            thumbnailDirectCostMicrousd:
              row.economicsV2.thumbnailDirectCostMicrousd,
            combinedDirectCostMicrousd:
              row.economicsV2.combinedDirectCostMicrousd,
            currency: "USD",
            unit: "MICRO",
            metadataCostBasisVersion: row.economicsV2.metadataCostBasisVersion,
            evidenceCostBasisVersion: row.economicsV2.evidenceCostBasisVersion,
            thumbnailCostBasisVersion:
              row.economicsV2.thumbnailCostBasisVersion,
            assistanceTiming: row.economicsV2.assistanceTiming,
            incompleteReasons: stringArray(
              row.economicsV2.incompleteReasons,
            ) ?? ["ECONOMICS_INCOMPLETE_REASONS_INVALID"],
            snapshotFingerprint: row.economicsV2.snapshotFingerprint,
          }
        : null,
    };
  }

  private staleReasons(row: ApprovalRow): EditorialApprovalStaleReason[] {
    const reasons: EditorialApprovalStaleReason[] = [];
    if (
      row.approvalContractVersion !== EDITORIAL_APPROVAL_CONTRACT &&
      row.approvalContractVersion !== EDITORIAL_APPROVAL_CONTRACT_V2
    )
      reasons.push("APPROVAL_CONTRACT_UNSUPPORTED");
    if (
      row.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT_V2 &&
      !v2SnapshotExact(row)
    )
      reasons.push("LINEAGE_INVALID");
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
  metadataSnapshotFingerprint: string;
  thumbnailSnapshotFingerprint: string;
  workflowMode: string;
}): string {
  return hashFixed([
    EDITORIAL_REVIEW_CONTRACT_V2,
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
    input.metadataSnapshotFingerprint,
    input.thumbnailSnapshotFingerprint,
    input.workflowMode,
    EDITORIAL_APPROVAL_CONTRACT_V2,
  ]);
}

function legacyCandidateFingerprintFor(input: {
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

function workflowModeFor(
  metadata: "MANUAL" | "AI_ASSISTED" | "MIXED",
  thumbnail: "MANUAL" | "AI_ASSISTED" | "MIXED",
): "MANUAL" | "AI_ASSISTED" | "MIXED" {
  if (metadata === "MANUAL" && thumbnail === "MANUAL") return "MANUAL";
  if (metadata === "AI_ASSISTED" && thumbnail === "AI_ASSISTED")
    return "AI_ASSISTED";
  return "MIXED";
}

function manualComponentSummary(
  component: "METADATA" | "THUMBNAIL",
  incompleteReasons: string[],
): EditorialReviewComponentSummary {
  return finalizeComponentSummary({
    component,
    provenanceId: null,
    mode: "MANUAL",
    basisVersion: "legacy-manual-editorial-v1",
    researchIntentId: null,
    suggestionSetId: null,
    imageIntentId: null,
    imageCandidateId: null,
    transcriptArtifactId: null,
    transcriptSha256: null,
    citations: [],
    research: null,
    imageSafetyDecision: null,
    likeness: null,
    directCostMicrousd: 0n,
    costBasisVersion: "local-manual-direct-ai-cost-v1",
    incompleteReasons,
  });
}

function finalizeComponentSummary(
  value: Omit<EditorialReviewComponentSummary, "snapshotFingerprint">,
): EditorialReviewComponentSummary {
  if (value.directCostMicrousd < 0n)
    value.incompleteReasons.push("DIRECT_COST_INVALID");
  const fingerprint = hashFixed([
    "editorial-approval-component-snapshot-v2",
    value.component,
    value.provenanceId ?? "",
    value.mode,
    value.basisVersion,
    value.researchIntentId ?? "",
    value.suggestionSetId ?? "",
    value.imageIntentId ?? "",
    value.imageCandidateId ?? "",
    value.transcriptArtifactId ?? "",
    value.transcriptSha256 ?? "",
    canonicalJson(value.citations),
    canonicalJson(value.research),
    canonicalJson(value.imageSafetyDecision),
    value.likeness ?? "",
    value.directCostMicrousd,
    value.costBasisVersion,
    canonicalJson(unique(value.incompleteReasons)),
  ]);
  return {
    ...value,
    incompleteReasons: unique(value.incompleteReasons),
    snapshotFingerprint: fingerprint,
  };
}

type SnapshotCitation = {
  id: string;
  url: string;
  title: string;
  publisher: string;
  publishedAt: Date | null;
  accessedAt: Date;
};

export function selectSuggestionCitations(
  intentCitations: SnapshotCitation[],
  suggestionCitationIds: unknown,
): SnapshotCitation[] | null {
  const ids = stringArray(suggestionCitationIds);
  if (
    intentCitations.length > 20 ||
    !ids ||
    new Set(ids).size !== ids.length ||
    intentCitations.some((citation) => !validPublicCitation(citation))
  )
    return null;
  const byId = new Map<string, SnapshotCitation>();
  for (const citation of intentCitations) {
    if (byId.has(citation.id)) return null;
    byId.set(citation.id, citation);
  }
  const selected: SnapshotCitation[] = [];
  for (const id of ids) {
    const citation = byId.get(id);
    if (!citation) return null;
    selected.push(citation);
  }
  return selected;
}

function validPublicCitation(value: SnapshotCitation): boolean {
  try {
    const normalizedUrl = normalizePublicCitationUrl(value.url);
    return (
      /^[0-9a-f-]{36}$/i.test(value.id) &&
      normalizedUrl === value.url &&
      value.title.length > 0 &&
      value.title.length <= 300 &&
      value.publisher.length > 0 &&
      value.publisher.length <= 200 &&
      Number.isFinite(value.accessedAt.getTime()) &&
      (value.publishedAt === null ||
        Number.isFinite(value.publishedAt.getTime()))
    );
  } catch {
    return false;
  }
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

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function approvalAttention(
  input: Parameters<EditorialApprovalRepository["create"]>[0],
): {
  version: string;
  preparationMs: number;
  finalReviewMs: number;
  totalMs: number;
} {
  if (input.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT_V2) {
    if (
      !input.attention ||
      input.attention.schemaVersion !== OPERATOR_ATTENTION_SCHEMA_V2
    )
      throw new EditorialApprovalCandidateConflictError();
    const total =
      input.attention.preparationForegroundMs +
      input.attention.finalReviewForegroundMs;
    if (
      !Number.isSafeInteger(total) ||
      input.attention.preparationForegroundMs < 0 ||
      input.attention.finalReviewForegroundMs < 0 ||
      total > 28_800_000
    )
      throw new EditorialApprovalCandidateConflictError();
    return {
      // Approval metrics v1 remains byte-for-byte/semantically compatible;
      // the v2 split and its schema version live in the economics snapshot.
      version: ATTENTION_MEASUREMENT_VERSION,
      preparationMs: input.attention.preparationForegroundMs,
      finalReviewMs: input.attention.finalReviewForegroundMs,
      totalMs: total,
    };
  }
  if (
    input.manualAttentionMs === undefined ||
    input.attentionMeasurementVersion !== ATTENTION_MEASUREMENT_VERSION
  )
    throw new EditorialApprovalCandidateConflictError();
  return {
    version: ATTENTION_MEASUREMENT_VERSION,
    preparationMs: 0,
    finalReviewMs: input.manualAttentionMs,
    totalMs: input.manualAttentionMs,
  };
}

function v2ApprovalSnapshotCreate(
  review: EditorialReviewView,
  attention: ReturnType<typeof approvalAttention>,
) {
  const components = [review.components.metadata, review.components.thumbnail];
  if (components.some((component) => !component.provenanceId))
    throw new EditorialApprovalCandidateConflictError();
  const economicsFingerprint = hashFixed([
    APPROVAL_ECONOMICS_SCHEMA_V2,
    review.workflowMode,
    attention.preparationMs,
    attention.finalReviewMs,
    ...components.map((component) => component.snapshotFingerprint),
    review.economicsPreview.metadataDirectCostMicrousd,
    review.economicsPreview.evidenceDirectCostMicrousd,
    review.economicsPreview.thumbnailDirectCostMicrousd,
    review.economicsPreview.combinedDirectCostMicrousd,
  ]);
  return {
    componentSnapshots: {
      create: components.map((component) => ({
        id: cryptoRandomUuid(),
        component: component.component,
        provenanceId: component.provenanceId!,
        mode: component.mode,
        basisVersion: component.basisVersion,
        researchIntentId: component.researchIntentId,
        suggestionSetId: component.suggestionSetId,
        imageIntentId: component.imageIntentId,
        imageCandidateId: component.imageCandidateId,
        transcriptArtifactId: component.transcriptArtifactId,
        transcriptSha256: component.transcriptSha256,
        citations: component.citations.map((citation) => ({
          ...citation,
          publishedAt: citation.publishedAt?.toISOString() ?? null,
          accessedAt: citation.accessedAt.toISOString(),
        })),
        freshness: component.research
          ? {
              ...component.research,
              searchedAt: component.research.searchedAt.toISOString(),
              freshUntil: component.research.freshUntil.toISOString(),
            }
          : undefined,
        imageSafetyDecision: component.imageSafetyDecision ?? undefined,
        likeness: component.likeness,
        directCostMicrousd: component.directCostMicrousd,
        costBasisVersion: component.costBasisVersion,
        incompleteReasons: component.incompleteReasons,
        snapshotFingerprint: component.snapshotFingerprint,
      })),
    },
    economicsV2: {
      create: {
        schemaVersion: APPROVAL_ECONOMICS_SCHEMA_V2,
        workflowMode: review.workflowMode,
        attentionSchemaVersion: OPERATOR_ATTENTION_SCHEMA_V2,
        preparationForegroundMs: attention.preparationMs,
        finalReviewForegroundMs: attention.finalReviewMs,
        totalOperatorAttentionMs: attention.totalMs,
        metadataDirectCostMicrousd:
          review.economicsPreview.metadataDirectCostMicrousd,
        evidenceDirectCostMicrousd:
          review.economicsPreview.evidenceDirectCostMicrousd,
        thumbnailDirectCostMicrousd:
          review.economicsPreview.thumbnailDirectCostMicrousd,
        combinedDirectCostMicrousd:
          review.economicsPreview.combinedDirectCostMicrousd,
        currency: "USD",
        unit: "MICRO",
        metadataCostBasisVersion: review.components.metadata.costBasisVersion,
        evidenceCostBasisVersion: "local-transcript-direct-ai-cost-v1",
        thumbnailCostBasisVersion: review.components.thumbnail.costBasisVersion,
        incompleteReasons: review.economicsPreview.incompleteReasons,
        snapshotFingerprint: economicsFingerprint,
      },
    },
  };
}

function mapPersistedComponentSnapshot(
  row: ApprovalRow["componentSnapshots"][number],
): EditorialReviewComponentSummary {
  const citations = parseSnapshotCitations(row.citations);
  const research = parseSnapshotFreshness(row.freshness);
  const imageSafetyDecision = projectNoLikenessSafetyDecision(
    row.imageSafetyDecision,
  );
  return {
    component: row.component,
    provenanceId: row.provenanceId,
    mode: row.mode,
    basisVersion: row.basisVersion,
    researchIntentId: row.researchIntentId,
    suggestionSetId: row.suggestionSetId,
    imageIntentId: row.imageIntentId,
    imageCandidateId: row.imageCandidateId,
    transcriptArtifactId: row.transcriptArtifactId,
    transcriptSha256: row.transcriptSha256,
    citations,
    research,
    imageSafetyDecision,
    likeness: row.likeness,
    directCostMicrousd: row.directCostMicrousd,
    costBasisVersion: row.costBasisVersion,
    incompleteReasons: stringArray(row.incompleteReasons) ?? [
      "SNAPSHOT_INVALID",
    ],
    snapshotFingerprint: row.snapshotFingerprint,
  };
}

function v2SnapshotExact(row: ApprovalRow): boolean {
  if (row.componentSnapshots.length !== 2 || !row.economicsV2) return false;
  const metadata = row.componentSnapshots.find(
    (value) => value.component === "METADATA",
  );
  const thumbnail = row.componentSnapshots.find(
    (value) => value.component === "THUMBNAIL",
  );
  if (!metadata || !thumbnail) return false;
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
    const mapped = mapPersistedComponentSnapshot(snapshot);
    if (
      (snapshot.component === "METADATA" &&
        snapshot.imageSafetyDecision !== null) ||
      (snapshot.component === "THUMBNAIL" &&
        snapshot.mode === "MANUAL" &&
        snapshot.imageSafetyDecision !== null) ||
      (snapshot.component === "THUMBNAIL" &&
        snapshot.mode === "AI_ASSISTED" &&
        (!mapped.imageSafetyDecision ||
          snapshot.imageCandidate?.contractVersion !==
            THUMBNAIL_CONTRACT_VERSION ||
          snapshot.imageCandidate.adapterVersion !==
            LOCAL_NO_LIKENESS_THUMBNAIL_ADAPTER_VERSION ||
          snapshot.imageCandidate.promptBasisVersion !==
            LOCAL_NO_LIKENESS_PROMPT_BASIS_VERSION ||
          !projectNoLikenessSafetyDecision(
            snapshot.imageCandidate.safetyDecision,
          ) ||
          canonicalJson(snapshot.imageCandidate.safetyDecision) !==
            canonicalJson(mapped.imageSafetyDecision)))
    )
      return false;
    const { snapshotFingerprint: _storedFingerprint, ...fingerprintInput } =
      mapped;
    if (
      finalizeComponentSummary(fingerprintInput).snapshotFingerprint !==
      snapshot.snapshotFingerprint
    )
      return false;
  }
  if (
    metadata.directCostMicrousd !==
      (metadata.suggestionSet?.directCostMicrousd ?? 0n) ||
    metadata.costBasisVersion !==
      (metadata.suggestionSet?.costBasisVersion ?? metadata.basisVersion) ||
    thumbnail.directCostMicrousd !==
      (thumbnail.imageCandidate?.directCostMicrousd ?? 0n) ||
    thumbnail.costBasisVersion !==
      (thumbnail.imageCandidate?.costBasisVersion ?? thumbnail.basisVersion)
  )
    return false;
  const economics = row.economicsV2;
  const workflow = workflowModeFor(metadata.mode, thumbnail.mode);
  const expectedEconomicsFingerprint = hashFixed([
    APPROVAL_ECONOMICS_SCHEMA_V2,
    workflow,
    economics.preparationForegroundMs,
    economics.finalReviewForegroundMs,
    metadata.snapshotFingerprint,
    thumbnail.snapshotFingerprint,
    metadata.directCostMicrousd,
    economics.evidenceDirectCostMicrousd,
    thumbnail.directCostMicrousd,
    metadata.directCostMicrousd +
      economics.evidenceDirectCostMicrousd +
      thumbnail.directCostMicrousd,
  ]);
  return (
    economics.workflowMode === workflow &&
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
    economics.snapshotFingerprint === expectedEconomicsFingerprint
  );
}

function parseSnapshotCitations(
  value: unknown,
): EditorialReviewComponentSummary["citations"] {
  if (!Array.isArray(value) || value.length > 20)
    throw new EditorialApprovalLineageInvalidError();
  return value.map((item) => {
    if (!item || typeof item !== "object")
      throw new EditorialApprovalLineageInvalidError();
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.url !== "string" ||
      typeof row.title !== "string" ||
      typeof row.publisher !== "string" ||
      typeof row.accessedAt !== "string"
    )
      throw new EditorialApprovalLineageInvalidError();
    const citation = {
      id: row.id,
      url: row.url,
      title: row.title,
      publisher: row.publisher,
      publishedAt:
        typeof row.publishedAt === "string" ? new Date(row.publishedAt) : null,
      accessedAt: new Date(row.accessedAt),
    };
    if (!validPublicCitation(citation))
      throw new EditorialApprovalLineageInvalidError();
    return citation;
  });
}

function parseSnapshotFreshness(
  value: unknown,
): EditorialReviewComponentSummary["research"] {
  if (value === null) return null;
  if (!value || typeof value !== "object")
    throw new EditorialApprovalLineageInvalidError();
  const row = value as Record<string, unknown>;
  if (
    typeof row.searchedAt !== "string" ||
    typeof row.freshUntil !== "string" ||
    (row.freshness !== "CURRENT" && row.freshness !== "EXPIRED")
  )
    throw new EditorialApprovalLineageInvalidError();
  const result = {
    searchedAt: new Date(row.searchedAt),
    freshUntil: new Date(row.freshUntil),
    freshness: row.freshness as "CURRENT" | "EXPIRED",
  };
  if (
    !Number.isFinite(result.searchedAt.getTime()) ||
    !Number.isFinite(result.freshUntil.getTime())
  )
    throw new EditorialApprovalLineageInvalidError();
  return result;
}

function cryptoRandomUuid(): string {
  return randomUUID();
}

export function canonicalApprovalRequestFingerprint(input: {
  approvalContractVersion:
    typeof EDITORIAL_APPROVAL_CONTRACT | typeof EDITORIAL_APPROVAL_CONTRACT_V2;
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
  manualAttentionMs?: number;
  attentionMeasurementVersion?: string;
  attention?: {
    schemaVersion: string;
    preparationForegroundMs: number;
    finalReviewForegroundMs: number;
  };
}): string {
  const tuple: Array<string | number | bigint> = [
    "CREATE_EDITORIAL_APPROVAL",
    input.approvalContractVersion,
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
  ];
  if (input.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT) {
    tuple.push(
      input.manualAttentionMs ?? "",
      input.attentionMeasurementVersion ?? "",
    );
  } else {
    tuple.push(
      input.attention?.schemaVersion ?? "",
      input.attention?.preparationForegroundMs ?? "",
      input.attention?.finalReviewForegroundMs ?? "",
    );
  }
  return hashFixed(tuple);
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
