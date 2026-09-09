import { Injectable } from "@nestjs/common";

import { sourceAuthorizationRuntime } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import { isSourceAuthorizationCleared } from "../../projects/domain/source-authorization.js";
import type { AssemblyRenderRepository } from "../application/assembly-render-repository.port.js";
import {
  AssemblyRenderAuthorizationError,
  AssemblyRenderCursorInvalidError,
  AssemblyRenderCutNotReadyError,
  AssemblyRenderIdempotencyConflictError,
  AssemblyRenderLimitsError,
  AssemblyRenderLineageInvalidError,
  AssemblyRenderProfileUnsupportedError,
  AssemblyRenderRecipeNotFoundError,
  AssemblyRenderRevisionConflictError,
  HORIZONTAL_RENDER_CONTRACT,
  type AssemblyRenderView,
} from "../domain/assembly-render.js";
import {
  ASSEMBLY_AUDIO_PROFILE,
  ASSEMBLY_ENCODING_PROFILE,
  ASSEMBLY_SCHEMA_VERSION,
} from "../domain/assembly-recipe.js";
import { montageRightsUsable } from "../domain/montage-asset.js";

const renderInclude = {
  source: { include: { authorizations: true } },
  recipeRevisionRecord: {
    include: {
      assetReferences: {
        include: { asset: true },
      },
    },
  },
  pipelineJob: true,
  result: { include: { artifact: true } },
} as const;

type RenderRow = NonNullable<
  Awaited<ReturnType<PrismaAssemblyRenderRepository["findRow"]>>
>;
type TransactionClient = Parameters<
  Parameters<PrismaService["$transaction"]>[0]
>[0];

@Injectable()
export class PrismaAssemblyRenderRepository implements AssemblyRenderRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: Parameters<AssemblyRenderRepository["create"]>[0]): Promise<{
    view: AssemblyRenderView;
    delivery: { jobId: string; attemptNumber: number };
  }> {
    return this.createWithRetry(input, 0);
  }

  private async createWithRetry(
    input: Parameters<AssemblyRenderRepository["create"]>[0],
    conflictCount: number,
  ): Promise<{
    view: AssemblyRenderView;
    delivery: { jobId: string; attemptNumber: number };
  }> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const replay = await tx.assemblyRenderRequest.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (replay) {
            if (replay.requestFingerprint !== input.requestFingerprint) {
              throw new AssemblyRenderIdempotencyConflictError();
            }
            const row = await this.findRow(replay.renderIntentId, tx);
            if (!row?.pipelineJob)
              throw new AssemblyRenderLineageInvalidError();
            this.requireAuthorization(row);
            return {
              view: this.map(row),
              delivery: {
                jobId: row.pipelineJob.id,
                attemptNumber: row.pipelineJob.attemptCount + 1,
              },
            };
          }

          const cut = await tx.pipelineJob.findUnique({
            where: { id: input.cutPipelineJobId },
            include: {
              segment: true,
              resultArtifact: true,
              source: { include: { authorizations: true } },
              assemblyRecipe: {
                include: {
                  revisions: {
                    where: { revision: input.recipeRevision },
                    include: {
                      assetReferences: {
                        include: { asset: true },
                        orderBy: [{ role: "asc" }, { ordinal: "asc" }],
                      },
                    },
                  },
                },
              },
            },
          });
          if (
            !cut ||
            cut.type !== "CUT_SEGMENT" ||
            cut.state !== "READY" ||
            !cut.segment ||
            !cut.resultArtifact
          ) {
            throw new AssemblyRenderCutNotReadyError();
          }
          if (!cut.assemblyRecipe)
            throw new AssemblyRenderRecipeNotFoundError();
          if (cut.assemblyRecipe.currentRevision !== input.recipeRevision) {
            throw new AssemblyRenderRevisionConflictError();
          }
          const revision = cut.assemblyRecipe.revisions[0];
          if (!revision) throw new AssemblyRenderRecipeNotFoundError();
          this.validateCut(cut);
          this.requireSourceAuthorization(
            cut.source.sourceVersion,
            cut.source.authorizations,
          );
          this.validateRevision(cut, revision);

          const existing = await tx.assemblyRenderIntent.findUnique({
            where: {
              recipeRevisionId_renderContractVersion: {
                recipeRevisionId: revision.id,
                renderContractVersion: HORIZONTAL_RENDER_CONTRACT,
              },
            },
            include: renderInclude,
          });
          if (existing) {
            if (!existing.pipelineJob)
              throw new AssemblyRenderLineageInvalidError();
            await tx.assemblyRenderRequest.create({
              data: {
                id: input.requestId,
                idempotencyKey: input.idempotencyKey,
                requestFingerprint: input.requestFingerprint,
                renderIntentId: existing.id,
              },
            });
            return {
              view: this.map(existing),
              delivery: {
                jobId: existing.pipelineJob.id,
                attemptNumber: existing.pipelineJob.attemptCount + 1,
              },
            };
          }

          const expectedDurationMs = this.expectedDuration(
            cut.segment.endMs - cut.segment.startMs,
            revision.assetReferences,
          );
          const intent = await tx.assemblyRenderIntent.create({
            data: {
              id: input.intentId,
              projectId: cut.projectId,
              sourceId: cut.sourceId,
              sourceVersion: cut.sourceVersion,
              cutPipelineJobId: cut.id,
              cutResultArtifactId: cut.resultArtifact.id,
              cutResultSha256: cut.resultArtifact.sha256,
              cutResultSizeBytes: cut.resultArtifact.sizeBytes,
              cutResultRecipeVersion: cut.resultArtifact.recipeVersion,
              assemblyRecipeId: cut.assemblyRecipe.id,
              recipeRevisionId: revision.id,
              recipeRevision: revision.revision,
              configurationFingerprint: revision.configurationFingerprint,
              renderContractVersion: HORIZONTAL_RENDER_CONTRACT,
              audioProfileVersion: revision.audioProfileVersion,
              encodingProfileVersion: revision.encodingProfileVersion,
              expectedDurationMs,
            },
          });
          await tx.pipelineJob.create({
            data: {
              id: input.jobId,
              projectId: cut.projectId,
              sourceId: cut.sourceId,
              sourceVersion: cut.sourceVersion,
              type: "ASSEMBLE_HORIZONTAL",
              payloadVersion: 1,
              idempotencyKey: `assembly:${HORIZONTAL_RENDER_CONTRACT}:${revision.id}`,
              recipeVersion: HORIZONTAL_RENDER_CONTRACT,
              totalMs: expectedDurationMs,
              retryBudget: 2,
              assemblyRenderIntentId: intent.id,
              attempts: {
                create: {
                  id: input.attemptId,
                  attemptNumber: 1,
                  state: "QUEUED",
                },
              },
            },
          });
          await tx.assemblyRenderRequest.create({
            data: {
              id: input.requestId,
              idempotencyKey: input.idempotencyKey,
              requestFingerprint: input.requestFingerprint,
              renderIntentId: intent.id,
            },
          });
          const row = await this.findRow(intent.id, tx);
          if (!row?.pipelineJob) throw new AssemblyRenderLineageInvalidError();
          return {
            view: this.map(row),
            delivery: { jobId: row.pipelineJob.id, attemptNumber: 1 },
          };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (this.isControlled(error)) throw error;
      if (this.isTransactionConflict(error) || this.isUniqueConstraint(error)) {
        if (conflictCount < 4) {
          await new Promise((resolve) =>
            setTimeout(resolve, 5 * 2 ** conflictCount),
          );
          return this.createWithRetry(input, conflictCount + 1);
        }
        const replay = await this.prisma.assemblyRenderRequest.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (!replay || replay.requestFingerprint !== input.requestFingerprint) {
          throw new AssemblyRenderIdempotencyConflictError();
        }
        const row = await this.findRow(replay.renderIntentId);
        if (!row?.pipelineJob) throw new AssemblyRenderLineageInvalidError();
        return {
          view: this.map(row),
          delivery: {
            jobId: row.pipelineJob.id,
            attemptNumber: row.pipelineJob.attemptCount + 1,
          },
        };
      }
      throw error;
    }
  }

  async get(renderId: string): Promise<AssemblyRenderView | null> {
    const row = await this.findRow(renderId);
    if (!row) return null;
    this.requireAuthorization(row);
    return this.map(row);
  }

  async listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<AssemblyRenderView[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      include: { source: { include: { authorizations: true } } },
    });
    if (!project?.source) throw new AssemblyRenderAuthorizationError();
    this.requireSourceAuthorization(
      project.source.sourceVersion,
      project.source.authorizations,
    );
    const anchor = input.cursor
      ? await this.prisma.assemblyRenderIntent.findFirst({
          where: { id: input.cursor, projectId: input.projectId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (input.cursor && !anchor) throw new AssemblyRenderCursorInvalidError();
    const rows = await this.prisma.assemblyRenderIntent.findMany({
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
      include: renderInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
    });
    return rows.map((row) => {
      this.requireAuthorization(row);
      return this.map(row);
    });
  }

  async getContent(renderId: string) {
    const row = await this.findRow(renderId);
    if (!row) return null;
    this.requireAuthorization(row);
    if (
      row.pipelineJob?.state !== "READY" ||
      !row.result ||
      row.result.artifact.status !== "READY" ||
      row.result.artifact.role !== "HORIZONTAL_ASSEMBLY_RESULT" ||
      row.result.artifact.projectId !== row.projectId ||
      row.result.artifact.lineageSourceId !== row.sourceId ||
      row.result.artifact.lineageSourceVersion !== row.sourceVersion ||
      row.result.artifact.pipelineJobId !== row.pipelineJob.id ||
      !row.result.artifact.outputFilename
    ) {
      return null;
    }
    return {
      objectKey: row.result.artifact.objectKey,
      sizeBytes: row.result.artifact.sizeBytes,
      filename: row.result.artifact.outputFilename,
    };
  }

  private findRow(
    id: string,
    client: PrismaService | TransactionClient = this.prisma,
  ) {
    return client.assemblyRenderIntent.findUnique({
      where: { id },
      include: renderInclude,
    });
  }

  private validateCut(cut: {
    projectId: string;
    sourceId: string;
    sourceVersion: number;
    recipeVersion: string;
    source: {
      id: string;
      projectId: string;
      sourceVersion: number;
      status: string;
    };
    resultArtifact: {
      projectId: string;
      sourceId: string;
      lineageSourceId: string;
      lineageSourceVersion: number;
      pipelineJobId: string | null;
      status: string;
      role: string;
      recipeVersion: string;
      sizeBytes: bigint;
      sha256: string;
    } | null;
    id: string;
  }): void {
    const artifact = cut.resultArtifact;
    if (
      !artifact ||
      cut.source.status !== "READY" ||
      cut.source.id !== cut.sourceId ||
      cut.source.projectId !== cut.projectId ||
      cut.source.sourceVersion !== cut.sourceVersion ||
      artifact.status !== "READY" ||
      artifact.role !== "CUT_RESULT" ||
      artifact.projectId !== cut.projectId ||
      artifact.sourceId !== cut.sourceId ||
      artifact.lineageSourceId !== cut.sourceId ||
      artifact.lineageSourceVersion !== cut.sourceVersion ||
      artifact.pipelineJobId !== cut.id ||
      artifact.recipeVersion !== cut.recipeVersion ||
      artifact.sizeBytes <= 0n ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      throw new AssemblyRenderLineageInvalidError();
    }
  }

  private validateRevision(
    cut: {
      projectId: string;
      sourceId: string;
      sourceVersion: number;
      segment: { startMs: number; endMs: number } | null;
    },
    revision: {
      schemaVersion: string;
      audioProfileVersion: string;
      encodingProfileVersion: string;
      configurationFingerprint: string;
      advertisementInsertAtMs: number | null;
      ctaText: string | null;
      ctaStartMs: number | null;
      ctaEndMs: number | null;
      ctaPosition: string | null;
      assetReferences: Array<{
        role: string;
        ordinal: number;
        assetId: string;
        assetRevision: number;
        assetSha256: string;
        assetSizeBytes: bigint;
        assetKind: string;
        assetDurationMs: number | null;
        startMs: number | null;
        endMs: number | null;
        position: string | null;
        asset: {
          id: string;
          projectId: string;
          sourceId: string;
          sourceVersion: number;
          revision: number;
          sha256: string;
          sizeBytes: bigint;
          kind: string;
          durationMs: number | null;
          status: string;
          rightsBasis: string;
          rightsDeclaration: string;
          rightsDecidedAt: Date;
        };
      }>;
    },
  ): void {
    if (
      revision.schemaVersion !== ASSEMBLY_SCHEMA_VERSION ||
      revision.audioProfileVersion !== ASSEMBLY_AUDIO_PROFILE ||
      revision.encodingProfileVersion !== ASSEMBLY_ENCODING_PROFILE ||
      !/^[a-f0-9]{64}$/.test(revision.configurationFingerprint)
    ) {
      throw new AssemblyRenderProfileUnsupportedError();
    }
    const cutDuration = cut.segment!.endMs - cut.segment!.startMs;
    const roleCount = (role: string) =>
      revision.assetReferences.filter((value) => value.role === role).length;
    if (
      revision.assetReferences.length > 11 ||
      roleCount("INTRO") > 1 ||
      roleCount("OUTRO") > 1 ||
      roleCount("ADVERTISEMENT") > 1 ||
      roleCount("BANNER") > 8 ||
      (roleCount("ADVERTISEMENT") === 0
        ? revision.advertisementInsertAtMs !== null
        : revision.advertisementInsertAtMs === null ||
          revision.advertisementInsertAtMs <= 0 ||
          revision.advertisementInsertAtMs >= cutDuration) ||
      (revision.ctaText === null
        ? revision.ctaStartMs !== null ||
          revision.ctaEndMs !== null ||
          revision.ctaPosition !== null
        : !revision.ctaText.trim() ||
          revision.ctaText.length > 120 ||
          revision.ctaStartMs === null ||
          revision.ctaEndMs === null ||
          revision.ctaPosition === null ||
          revision.ctaStartMs < 0 ||
          revision.ctaEndMs <= revision.ctaStartMs ||
          revision.ctaEndMs > cutDuration)
    )
      throw new AssemblyRenderLimitsError();
    for (const reference of revision.assetReferences) {
      const asset = reference.asset;
      if (
        asset.id !== reference.assetId ||
        asset.projectId !== cut.projectId ||
        asset.sourceId !== cut.sourceId ||
        asset.sourceVersion !== cut.sourceVersion ||
        asset.status !== "READY" ||
        asset.revision !== reference.assetRevision ||
        asset.sha256 !== reference.assetSha256 ||
        asset.sizeBytes !== reference.assetSizeBytes ||
        asset.kind !== reference.assetKind ||
        asset.durationMs !== reference.assetDurationMs
      ) {
        throw new AssemblyRenderLineageInvalidError();
      }
      if (!montageRightsUsable(asset, sourceAuthorizationRuntime().policy)) {
        throw new AssemblyRenderAuthorizationError();
      }
      if (
        reference.role === "BANNER" &&
        (reference.assetDurationMs !== null ||
          reference.startMs === null ||
          reference.endMs === null ||
          reference.startMs < 0 ||
          reference.endMs <= reference.startMs ||
          reference.endMs > cutDuration ||
          reference.position === null)
      ) {
        throw new AssemblyRenderLineageInvalidError();
      }
      if (
        reference.role !== "BANNER" &&
        (reference.assetDurationMs === null || reference.assetDurationMs <= 0)
      ) {
        throw new AssemblyRenderLineageInvalidError();
      }
    }
  }

  private expectedDuration(
    cutDurationMs: number,
    references: Array<{ role: string; assetDurationMs: number | null }>,
  ): number {
    const duration = references.reduce(
      (sum, value) =>
        value.role === "BANNER" ? sum : sum + (value.assetDurationMs ?? 0),
      cutDurationMs,
    );
    if (duration <= 0 || duration > 43_200_000)
      throw new AssemblyRenderLimitsError();
    return duration;
  }

  private requireAuthorization(row: RenderRow): void {
    this.requireSourceAuthorization(
      row.sourceVersion,
      row.source.authorizations,
    );
    if (
      row.recipeRevisionRecord.assetReferences.some(
        (reference) =>
          !montageRightsUsable(
            reference.asset,
            sourceAuthorizationRuntime().policy,
          ),
      )
    ) {
      throw new AssemblyRenderAuthorizationError();
    }
  }

  private requireSourceAuthorization(
    sourceVersion: number,
    decisions: Array<{
      sourceVersion: number;
      status: string;
      basis: string | null;
      declarationVersion: string | null;
      decidedAt: Date | null;
    }>,
  ): void {
    const decision = decisions.find(
      (value) => value.sourceVersion === sourceVersion,
    );
    if (
      !isSourceAuthorizationCleared(
        decision as Parameters<typeof isSourceAuthorizationCleared>[0],
        sourceVersion,
        sourceAuthorizationRuntime().policy,
      )
    ) {
      throw new AssemblyRenderAuthorizationError();
    }
  }

  private map(row: RenderRow): AssemblyRenderView {
    const job = row.pipelineJob;
    if (
      !job ||
      job.type !== "ASSEMBLE_HORIZONTAL" ||
      job.assemblyRenderIntentId !== row.id ||
      job.projectId !== row.projectId ||
      job.sourceId !== row.sourceId ||
      job.sourceVersion !== row.sourceVersion ||
      job.recipeVersion !== HORIZONTAL_RENDER_CONTRACT
    ) {
      throw new AssemblyRenderLineageInvalidError();
    }
    const inputs = [
      {
        id: row.cutResultArtifactId,
        role: "CUT" as const,
        revision: null,
        sha256: row.cutResultSha256,
        sizeBytes: row.cutResultSizeBytes,
        durationMs:
          row.expectedDurationMs -
          row.recipeRevisionRecord.assetReferences.reduce(
            (sum, value) =>
              value.role === "BANNER"
                ? sum
                : sum + (value.assetDurationMs ?? 0),
            0,
          ),
      },
      ...row.recipeRevisionRecord.assetReferences.map((reference) => ({
        id: reference.assetId,
        role: reference.role,
        revision: reference.assetRevision,
        sha256: reference.assetSha256,
        sizeBytes: reference.assetSizeBytes,
        durationMs: reference.assetDurationMs,
      })),
    ];
    return {
      id: row.id,
      projectId: row.projectId,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
      cutPipelineJobId: row.cutPipelineJobId,
      cutResultArtifactId: row.cutResultArtifactId,
      assemblyRecipeId: row.assemblyRecipeId,
      recipeRevisionId: row.recipeRevisionId,
      recipeRevision: row.recipeRevision,
      configurationFingerprint: row.configurationFingerprint,
      renderContractVersion: HORIZONTAL_RENDER_CONTRACT,
      audioProfileVersion: ASSEMBLY_AUDIO_PROFILE,
      encodingProfileVersion: ASSEMBLY_ENCODING_PROFILE,
      expectedDurationMs: row.expectedDurationMs,
      inputs,
      job: {
        id: job.id,
        revision: job.revision,
        state: job.state,
        attempt: job.attemptCount,
        retryBudget: job.retryBudget,
        nextAttemptAt: job.nextAttemptAt,
        admissionReason: job.admissionReason,
        progress:
          job.progressAttemptNumber !== null &&
          job.progressPhase !== null &&
          !["READ_INPUTS", "WRITE_ARCHIVE"].includes(job.progressPhase) &&
          job.progressBasisPoints !== null &&
          job.progressUpdatedAt !== null
            ? {
                schemaVersion: "assembly-progress-v1",
                attemptNumber: job.progressAttemptNumber,
                phase: job.progressPhase as Exclude<
                  typeof job.progressPhase,
                  "READ_INPUTS" | "WRITE_ARCHIVE"
                >,
                basisPoints: job.progressBasisPoints,
                updatedAt: job.progressUpdatedAt,
              }
            : null,
        failure:
          job.failureCode && job.failureMessage && job.failureRetryable !== null
            ? {
                code: job.failureCode,
                message: job.failureMessage,
                retryable: job.failureRetryable,
              }
            : null,
      },
      result: row.result
        ? {
            filename: row.result.artifact.outputFilename ?? "assembled.mp4",
            sizeBytes: row.result.artifact.sizeBytes,
            sha256: row.result.artifact.sha256,
            durationMs: row.result.durationMs,
            width: row.result.width,
            height: row.result.height,
            fpsNumerator: row.result.fpsNumerator,
            fpsDenominator: row.result.fpsDenominator,
            videoCodec: row.result.videoCodec,
            pixelFormat: row.result.pixelFormat,
            audioCodec: row.result.audioCodec,
            audioSampleRate: row.result.audioSampleRate,
            audioChannels: row.result.audioChannels,
            integratedLoudnessLufs: row.result.integratedLoudnessLufs,
            truePeakDbtp: row.result.truePeakDbtp,
            normalizationProfileResult: row.result.normalizationProfileResult,
            ffmpegVersion: row.result.ffmpegVersion,
            ffprobeVersion: row.result.ffprobeVersion,
            completedAt: row.result.completedAt,
          }
        : null,
      createdAt: row.createdAt,
    };
  }

  private isControlled(error: unknown): boolean {
    return (
      error instanceof AssemblyRenderIdempotencyConflictError ||
      error instanceof AssemblyRenderCutNotReadyError ||
      error instanceof AssemblyRenderRecipeNotFoundError ||
      error instanceof AssemblyRenderRevisionConflictError ||
      error instanceof AssemblyRenderLineageInvalidError ||
      error instanceof AssemblyRenderProfileUnsupportedError ||
      error instanceof AssemblyRenderAuthorizationError ||
      error instanceof AssemblyRenderLimitsError
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
