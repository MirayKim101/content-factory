import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { sourceAuthorizationRuntime } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import {
  isSourceAuthorizationCleared,
  SourceAuthorizationRequiredError,
} from "../../projects/domain/source-authorization.js";
import type { AssemblyRecipeRepository } from "../application/assembly-recipe-repository.port.js";
import {
  ASSEMBLY_AUDIO_PROFILE,
  ASSEMBLY_ENCODING_PROFILE,
  ASSEMBLY_SCHEMA_VERSION,
  AssemblyRecipeAssetInvalidError,
  AssemblyRecipeAssetNotFoundError,
  AssemblyRecipeAssetRightsError,
  AssemblyRecipeConfigurationError,
  AssemblyRecipeCursorInvalidError,
  AssemblyRecipeCutLineageInvalidError,
  AssemblyRecipeCutNotReadyError,
  AssemblyRecipeIdempotencyConflictError,
  AssemblyRecipePersistenceError,
  AssemblyRecipeProjectNotFoundError,
  AssemblyRecipeRevisionConflictError,
  type AssemblyAssetSnapshot,
  type AssemblyRecipeConfiguration,
  type AssemblyRecipeView,
} from "../domain/assembly-recipe.js";
import { montageRightsUsable } from "../domain/montage-asset.js";

const recipeInclude = {
  cutResultArtifact: true,
  pipelineJob: {
    include: {
      segment: true,
      source: { include: { authorizations: true } },
    },
  },
  revisions: {
    include: { assetReferences: { include: { asset: true } } },
    orderBy: { revision: "desc" as const },
  },
} as const;

type RecipeRow = NonNullable<
  Awaited<ReturnType<PrismaAssemblyRecipeRepository["findRecipeRow"]>>
>;
type SaveInput = Parameters<AssemblyRecipeRepository["save"]>[0];
type TransactionClient = Parameters<
  Parameters<PrismaService["$transaction"]>[0]
>[0];

@Injectable()
export class PrismaAssemblyRecipeRepository implements AssemblyRecipeRepository {
  constructor(private readonly prisma: PrismaService) {}

  save(input: SaveInput): Promise<AssemblyRecipeView> {
    return this.saveWithRetry(input, 0);
  }

  private async saveWithRetry(
    input: SaveInput,
    conflictCount: number,
  ): Promise<AssemblyRecipeView> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const replay = await tx.assemblyRecipeMutationRequest.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
            select: {
              requestFingerprint: true,
              recipeRevision: {
                select: { recipeId: true, revision: true },
              },
            },
          });
          if (replay) {
            if (replay.requestFingerprint !== input.requestFingerprint) {
              throw new AssemblyRecipeIdempotencyConflictError();
            }
            const row = await this.findRecipeRow(
              replay.recipeRevision.recipeId,
              tx,
            );
            if (!row) throw new AssemblyRecipePersistenceError();
            return this.mapRecipe(row, replay.recipeRevision.revision);
          }

          const cut = await this.requireReadyCut(input.pipelineJobId, tx);
          this.validateConfiguration(input.configuration, cut.durationMs);
          const assetReferences = await this.resolveAssets(
            input.configuration,
            {
              projectId: cut.job.projectId,
              sourceId: cut.job.sourceId,
              sourceVersion: cut.job.sourceVersion,
            },
            input.assetReferenceIds,
            tx,
          );
          const current = await tx.assemblyRecipe.findUnique({
            where: { pipelineJobId: cut.job.id },
          });
          const nextRevision = input.expectedRevision + 1;
          if (!current) {
            if (input.expectedRevision !== 0) {
              throw new AssemblyRecipeRevisionConflictError();
            }
            await tx.assemblyRecipe.create({
              data: {
                id: input.recipeId,
                projectId: cut.job.projectId,
                pipelineJobId: cut.job.id,
                cutResultArtifactId: cut.artifact.id,
                cutResultSha256: cut.artifact.sha256,
                cutResultSizeBytes: cut.artifact.sizeBytes,
                cutResultRecipeVersion: cut.artifact.recipeVersion,
                lineageSourceId: cut.artifact.lineageSourceId,
                lineageSourceVersion: cut.artifact.lineageSourceVersion,
                cutDurationMs: cut.durationMs,
                currentRevision: 1,
                revisions: {
                  create: this.revisionData(input, 1, assetReferences),
                },
              },
            });
            const created = await this.findRecipeRow(input.recipeId, tx);
            if (!created) throw new AssemblyRecipePersistenceError();
            return this.mapRecipe(created, 1);
          }
          if (
            current.currentRevision !== input.expectedRevision ||
            current.projectId !== cut.job.projectId ||
            current.pipelineJobId !== cut.job.id ||
            current.cutResultArtifactId !== cut.artifact.id ||
            current.cutResultSha256 !== cut.artifact.sha256 ||
            current.cutResultSizeBytes !== cut.artifact.sizeBytes ||
            current.cutResultRecipeVersion !== cut.artifact.recipeVersion ||
            current.lineageSourceId !== cut.artifact.lineageSourceId ||
            current.lineageSourceVersion !==
              cut.artifact.lineageSourceVersion ||
            current.cutDurationMs !== cut.durationMs
          ) {
            throw new AssemblyRecipeRevisionConflictError();
          }
          const advanced = await tx.assemblyRecipe.updateMany({
            where: {
              id: current.id,
              currentRevision: input.expectedRevision,
              cutResultArtifactId: cut.artifact.id,
            },
            data: { currentRevision: nextRevision },
          });
          if (advanced.count !== 1) {
            throw new AssemblyRecipeRevisionConflictError();
          }
          await tx.assemblyRecipeRevision.create({
            data: {
              recipeId: current.id,
              ...this.revisionData(input, nextRevision, assetReferences),
            },
          });
          const updated = await this.findRecipeRow(current.id, tx);
          if (!updated) throw new AssemblyRecipePersistenceError();
          return this.mapRecipe(updated, nextRevision);
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (this.isControlled(error)) throw error;
      if (this.isTransactionConflict(error)) {
        if (conflictCount < 4) {
          await this.waitForConcurrentCommit(conflictCount);
          return this.saveWithRetry(input, conflictCount + 1);
        }
        throw new AssemblyRecipeRevisionConflictError();
      }
      if (!this.isUniqueConstraint(error)) throw error;
      const replay = await this.prisma.assemblyRecipeMutationRequest.findUnique(
        {
          where: { idempotencyKey: input.idempotencyKey },
          select: {
            requestFingerprint: true,
            recipeRevision: { select: { recipeId: true, revision: true } },
          },
        },
      );
      if (replay?.requestFingerprint !== input.requestFingerprint) {
        throw new AssemblyRecipeIdempotencyConflictError();
      }
      if (!replay) {
        if (conflictCount < 4) {
          await this.waitForConcurrentCommit(conflictCount);
          return this.saveWithRetry(input, conflictCount + 1);
        }
        throw new AssemblyRecipeRevisionConflictError();
      }
      const row = await this.findRecipeRow(replay.recipeRevision.recipeId);
      if (!row) throw new AssemblyRecipePersistenceError();
      return this.mapRecipe(row, replay.recipeRevision.revision);
    }
  }

  async getCurrent(pipelineJobId: string): Promise<AssemblyRecipeView | null> {
    await this.requireReadyCut(pipelineJobId, this.prisma);
    const row = await this.prisma.assemblyRecipe.findUnique({
      where: { pipelineJobId },
      include: recipeInclude,
    });
    return row ? this.mapRecipe(row, row.currentRevision) : null;
  }

  async getRevision(
    pipelineJobId: string,
    revision: number,
  ): Promise<AssemblyRecipeView | null> {
    await this.requireReadyCut(pipelineJobId, this.prisma);
    const row = await this.prisma.assemblyRecipe.findUnique({
      where: { pipelineJobId },
      include: recipeInclude,
    });
    if (!row || !row.revisions.some((value) => value.revision === revision)) {
      return null;
    }
    return this.mapRecipe(row, revision);
  }

  async listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<AssemblyRecipeView[]> {
    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      include: { source: { include: { authorizations: true } } },
    });
    if (!project) throw new AssemblyRecipeProjectNotFoundError();
    if (!project.source) throw new SourceAuthorizationRequiredError();
    this.requireSourceAuthorization(
      project.source.sourceVersion,
      project.source.authorizations,
    );
    const anchor = input.cursor
      ? await this.prisma.assemblyRecipe.findFirst({
          where: { id: input.cursor, projectId: input.projectId },
          select: { id: true, updatedAt: true },
        })
      : null;
    if (input.cursor && !anchor) {
      throw new AssemblyRecipeCursorInvalidError();
    }
    const rows = await this.prisma.assemblyRecipe.findMany({
      where: {
        projectId: input.projectId,
        ...(anchor
          ? {
              OR: [
                { updatedAt: { lt: anchor.updatedAt } },
                { updatedAt: anchor.updatedAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      include: recipeInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: input.limit,
    });
    return rows.map((row) => this.mapRecipe(row, row.currentRevision));
  }

  private async requireReadyCut(
    pipelineJobId: string,
    client: Pick<PrismaService, "pipelineJob"> | TransactionClient,
  ) {
    const job = await client.pipelineJob.findUnique({
      where: { id: pipelineJobId },
      include: {
        segment: true,
        resultArtifact: true,
        source: { include: { authorizations: true } },
      },
    });
    if (
      !job ||
      job.type !== "CUT_SEGMENT" ||
      job.state !== "READY" ||
      !job.segment
    ) {
      throw new AssemblyRecipeCutNotReadyError();
    }
    if (
      job.source.status !== "READY" ||
      job.source.sourceVersion !== job.sourceVersion ||
      job.source.id !== job.sourceId ||
      job.source.projectId !== job.projectId
    ) {
      throw new AssemblyRecipeCutLineageInvalidError();
    }
    this.requireSourceAuthorization(
      job.sourceVersion,
      job.source.authorizations,
    );
    const artifact = job.resultArtifact;
    const durationMs = job.segment.endMs - job.segment.startMs;
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
      artifact.sizeBytes <= 0n ||
      durationMs <= 0
    ) {
      throw new AssemblyRecipeCutLineageInvalidError();
    }
    return { job, artifact, durationMs };
  }

  private validateConfiguration(
    value: AssemblyRecipeConfiguration,
    durationMs: number,
  ): void {
    if (
      value.audioProfileVersion !== ASSEMBLY_AUDIO_PROFILE ||
      value.encodingProfileVersion !== ASSEMBLY_ENCODING_PROFILE ||
      value.banners.length > 8 ||
      new Set(value.banners.map((banner) => banner.clientItemId)).size !==
        value.banners.length ||
      value.banners.some(
        (banner) =>
          !banner.clientItemId.trim() ||
          banner.clientItemId.length > 100 ||
          banner.startMs < 0 ||
          banner.endMs <= banner.startMs ||
          banner.endMs > durationMs,
      ) ||
      (value.advertisement !== null &&
        (value.advertisement.insertAtMs <= 0 ||
          value.advertisement.insertAtMs >= durationMs)) ||
      (value.cta !== null &&
        (!value.cta.text.trim() ||
          value.cta.text.length > 120 ||
          value.cta.startMs < 0 ||
          value.cta.endMs <= value.cta.startMs ||
          value.cta.endMs > durationMs))
    ) {
      throw new AssemblyRecipeConfigurationError(
        "Assembly recipe timing or limits are invalid.",
      );
    }
  }

  private async resolveAssets(
    configuration: AssemblyRecipeConfiguration,
    context: { projectId: string; sourceId: string; sourceVersion: number },
    ids: string[],
    tx: TransactionClient,
  ) {
    const requested = [
      ...(configuration.introAssetId
        ? [
            {
              role: "INTRO" as const,
              ordinal: 0,
              assetId: configuration.introAssetId,
            },
          ]
        : []),
      ...(configuration.outroAssetId
        ? [
            {
              role: "OUTRO" as const,
              ordinal: 0,
              assetId: configuration.outroAssetId,
            },
          ]
        : []),
      ...(configuration.advertisement
        ? [
            {
              role: "ADVERTISEMENT" as const,
              ordinal: 0,
              assetId: configuration.advertisement.assetId,
            },
          ]
        : []),
      ...configuration.banners.map((banner, ordinal) => ({
        role: "BANNER" as const,
        ordinal,
        assetId: banner.assetId,
        clientItemId: banner.clientItemId,
        startMs: banner.startMs,
        endMs: banner.endMs,
        position: banner.position,
      })),
    ];
    if (ids.length !== requested.length) {
      throw new AssemblyRecipePersistenceError();
    }
    const uniqueIds = [...new Set(requested.map((item) => item.assetId))];
    const assets = await tx.montageAsset.findMany({
      where: { id: { in: uniqueIds } },
    });
    if (assets.length !== uniqueIds.length) {
      throw new AssemblyRecipeAssetNotFoundError();
    }
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    return requested.map((requestedAsset, index) => {
      const asset = byId.get(requestedAsset.assetId);
      if (!asset) throw new AssemblyRecipeAssetNotFoundError();
      if (!montageRightsUsable(asset, sourceAuthorizationRuntime().policy)) {
        throw new AssemblyRecipeAssetRightsError();
      }
      if (
        asset.status !== "READY" ||
        asset.projectId !== context.projectId ||
        asset.sourceId !== context.sourceId ||
        asset.sourceVersion !== context.sourceVersion ||
        asset.kind !== requestedAsset.role ||
        !this.isSha256(asset.sha256) ||
        asset.sizeBytes <= 0n ||
        (asset.kind === "BANNER"
          ? asset.durationMs !== null
          : !asset.durationMs || asset.durationMs <= 0)
      ) {
        throw new AssemblyRecipeAssetInvalidError();
      }
      return {
        id: ids[index]!,
        role: requestedAsset.role,
        ordinal: requestedAsset.ordinal,
        assetId: asset.id,
        assetRevision: asset.revision,
        assetSha256: asset.sha256,
        assetSizeBytes: asset.sizeBytes,
        assetKind: asset.kind,
        assetDurationMs: asset.durationMs,
        clientItemId:
          "clientItemId" in requestedAsset ? requestedAsset.clientItemId : null,
        startMs: "startMs" in requestedAsset ? requestedAsset.startMs : null,
        endMs: "endMs" in requestedAsset ? requestedAsset.endMs : null,
        position: "position" in requestedAsset ? requestedAsset.position : null,
      };
    });
  }

  private revisionData(
    input: SaveInput,
    revision: number,
    assets: Awaited<
      ReturnType<PrismaAssemblyRecipeRepository["resolveAssets"]>
    >,
  ) {
    return {
      id: input.revisionId,
      revision,
      schemaVersion: ASSEMBLY_SCHEMA_VERSION,
      configurationFingerprint: input.configurationFingerprint,
      audioProfileVersion: input.configuration.audioProfileVersion,
      encodingProfileVersion: input.configuration.encodingProfileVersion,
      advertisementInsertAtMs:
        input.configuration.advertisement?.insertAtMs ?? null,
      ctaText: input.configuration.cta?.text ?? null,
      ctaStartMs: input.configuration.cta?.startMs ?? null,
      ctaEndMs: input.configuration.cta?.endMs ?? null,
      ctaPosition: input.configuration.cta?.position ?? null,
      assetReferences: { create: assets },
      mutationRequests: {
        create: {
          id: input.mutationId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        },
      },
    };
  }

  private async findRecipeRow(
    recipeId: string,
    client: Pick<PrismaService, "assemblyRecipe"> | TransactionClient = this
      .prisma,
  ) {
    return client.assemblyRecipe.findUnique({
      where: { id: recipeId },
      include: recipeInclude,
    });
  }

  private mapRecipe(
    row: RecipeRow,
    revisionNumber: number,
  ): AssemblyRecipeView {
    if (
      row.pipelineJob.type !== "CUT_SEGMENT" ||
      row.pipelineJob.state !== "READY" ||
      !row.pipelineJob.segment
    ) {
      throw new AssemblyRecipeCutNotReadyError();
    }
    if (
      row.pipelineJob.source.status !== "READY" ||
      row.pipelineJob.source.sourceVersion !== row.pipelineJob.sourceVersion ||
      row.pipelineJob.source.id !== row.pipelineJob.sourceId ||
      row.pipelineJob.source.projectId !== row.pipelineJob.projectId ||
      row.pipelineJob.projectId !== row.projectId
    ) {
      throw new AssemblyRecipeCutLineageInvalidError();
    }
    this.requireSourceAuthorization(
      row.pipelineJob.sourceVersion,
      row.pipelineJob.source.authorizations,
    );
    const durationMs =
      row.pipelineJob.segment.endMs - row.pipelineJob.segment.startMs;
    const artifact = row.cutResultArtifact;
    if (
      artifact.id !== row.cutResultArtifactId ||
      artifact.status !== "READY" ||
      artifact.role !== "CUT_RESULT" ||
      artifact.projectId !== row.projectId ||
      artifact.sourceId !== row.pipelineJob.sourceId ||
      artifact.lineageSourceId !== row.pipelineJob.sourceId ||
      artifact.lineageSourceVersion !== row.pipelineJob.sourceVersion ||
      artifact.pipelineJobId !== row.pipelineJobId ||
      artifact.recipeVersion !== row.pipelineJob.recipeVersion ||
      row.cutResultSha256 !== artifact.sha256 ||
      row.cutResultSizeBytes !== artifact.sizeBytes ||
      row.cutResultRecipeVersion !== artifact.recipeVersion ||
      row.lineageSourceId !== artifact.lineageSourceId ||
      row.lineageSourceVersion !== artifact.lineageSourceVersion ||
      row.cutDurationMs !== durationMs ||
      !this.isSha256(artifact.sha256) ||
      artifact.sizeBytes <= 0n ||
      durationMs <= 0
    ) {
      throw new AssemblyRecipeCutLineageInvalidError();
    }
    const revision = row.revisions.find(
      (candidate) => candidate.revision === revisionNumber,
    );
    if (!revision) throw new AssemblyRecipePersistenceError();
    if (
      revision.schemaVersion !== ASSEMBLY_SCHEMA_VERSION ||
      revision.audioProfileVersion !== ASSEMBLY_AUDIO_PROFILE ||
      revision.encodingProfileVersion !== ASSEMBLY_ENCODING_PROFILE
    ) {
      throw new AssemblyRecipePersistenceError();
    }
    const references = [...revision.assetReferences].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    for (const reference of references) {
      const asset = reference.asset;
      if (!montageRightsUsable(asset, sourceAuthorizationRuntime().policy)) {
        throw new AssemblyRecipeAssetRightsError();
      }
      if (
        asset.status !== "READY" ||
        asset.projectId !== row.projectId ||
        asset.sourceId !== row.lineageSourceId ||
        asset.sourceVersion !== row.lineageSourceVersion ||
        asset.kind !== reference.role ||
        asset.id !== reference.assetId ||
        asset.revision !== reference.assetRevision ||
        asset.sha256 !== reference.assetSha256 ||
        asset.sizeBytes !== reference.assetSizeBytes ||
        asset.kind !== reference.assetKind ||
        asset.durationMs !== reference.assetDurationMs
      ) {
        throw new AssemblyRecipeAssetInvalidError();
      }
    }
    const intro = references.find((value) => value.role === "INTRO") ?? null;
    const outro = references.find((value) => value.role === "OUTRO") ?? null;
    const advertisement =
      references.find((value) => value.role === "ADVERTISEMENT") ?? null;
    const banners = references.filter((value) => value.role === "BANNER");
    const ctaFields = [
      revision.ctaText,
      revision.ctaStartMs,
      revision.ctaEndMs,
      revision.ctaPosition,
    ];
    const hasCta = revision.ctaText !== null;
    if (
      ctaFields.some((field) => field === null) !==
        ctaFields.every((field) => field === null) ||
      (hasCta && !revision.ctaText?.trim())
    ) {
      throw new AssemblyRecipePersistenceError();
    }
    const configuration: AssemblyRecipeConfiguration = {
      introAssetId: intro?.assetId ?? null,
      outroAssetId: outro?.assetId ?? null,
      advertisement: advertisement
        ? {
            assetId: advertisement.assetId,
            insertAtMs: revision.advertisementInsertAtMs!,
          }
        : null,
      banners: banners.map((banner) => ({
        clientItemId: banner.clientItemId!,
        assetId: banner.assetId,
        startMs: banner.startMs!,
        endMs: banner.endMs!,
        position: banner.position!,
      })),
      cta: hasCta
        ? {
            text: revision.ctaText!,
            startMs: revision.ctaStartMs!,
            endMs: revision.ctaEndMs!,
            position: revision.ctaPosition!,
          }
        : null,
      audioProfileVersion: ASSEMBLY_AUDIO_PROFILE,
      encodingProfileVersion: ASSEMBLY_ENCODING_PROFILE,
    };
    if (
      (advertisement === null) !==
      (revision.advertisementInsertAtMs === null)
    ) {
      throw new AssemblyRecipePersistenceError();
    }
    this.validateConfiguration(configuration, durationMs);
    if (this.fingerprint(configuration) !== revision.configurationFingerprint) {
      throw new AssemblyRecipePersistenceError();
    }
    return {
      id: row.id,
      projectId: row.projectId,
      pipelineJobId: row.pipelineJobId,
      cutResultArtifact: {
        id: artifact.id,
        sha256: row.cutResultSha256,
        sizeBytes: row.cutResultSizeBytes,
        sourceId: row.lineageSourceId,
        sourceVersion: row.lineageSourceVersion,
        recipeVersion: row.cutResultRecipeVersion,
        durationMs: row.cutDurationMs,
      },
      revision: {
        id: revision.id,
        revision: revision.revision,
        schemaVersion: ASSEMBLY_SCHEMA_VERSION,
        configurationFingerprint: revision.configurationFingerprint,
        configuration,
        assets: {
          intro: intro ? this.assetSnapshot(intro) : null,
          outro: outro ? this.assetSnapshot(outro) : null,
          advertisement: advertisement
            ? this.assetSnapshot(advertisement)
            : null,
          banners: banners.map((banner) => this.assetSnapshot(banner)),
        },
        createdAt: revision.createdAt,
      },
      validation: { valid: true },
      createdAt: row.createdAt,
      updatedAt:
        revisionNumber === row.currentRevision
          ? row.updatedAt
          : revision.createdAt,
    };
  }

  private assetSnapshot(reference: {
    assetId: string;
    assetRevision: number;
    assetSha256: string;
    assetSizeBytes: bigint;
    assetKind: "ADVERTISEMENT" | "INTRO" | "OUTRO" | "BANNER";
    assetDurationMs: number | null;
  }): AssemblyAssetSnapshot {
    return {
      id: reference.assetId,
      revision: reference.assetRevision,
      sha256: reference.assetSha256,
      sizeBytes: reference.assetSizeBytes,
      kind: reference.assetKind,
      durationMs: reference.assetDurationMs,
    };
  }

  private requireSourceAuthorization(
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
    if (
      !isSourceAuthorizationCleared(
        authorization
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
          : null,
        sourceVersion,
        sourceAuthorizationRuntime().policy,
      )
    ) {
      throw new SourceAuthorizationRequiredError();
    }
  }

  private fingerprint(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private isSha256(value: string): boolean {
    return /^[a-f0-9]{64}$/.test(value);
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

  private isControlled(error: unknown): boolean {
    return (
      error instanceof SourceAuthorizationRequiredError ||
      error instanceof AssemblyRecipeIdempotencyConflictError ||
      error instanceof AssemblyRecipeRevisionConflictError ||
      error instanceof AssemblyRecipeProjectNotFoundError ||
      error instanceof AssemblyRecipeCutNotReadyError ||
      error instanceof AssemblyRecipeCutLineageInvalidError ||
      error instanceof AssemblyRecipeAssetNotFoundError ||
      error instanceof AssemblyRecipeAssetInvalidError ||
      error instanceof AssemblyRecipeAssetRightsError ||
      error instanceof AssemblyRecipeConfigurationError ||
      error instanceof AssemblyRecipeCursorInvalidError ||
      error instanceof AssemblyRecipePersistenceError
    );
  }

  private waitForConcurrentCommit(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
  }
}
