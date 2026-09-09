import { Inject, Injectable } from "@nestjs/common";

import type {
  AiContentOperationType,
  CreatorReferenceAuthorizationRevision,
  CreatorReferenceAsset,
  Prisma,
} from "../../generated/prisma/client.js";
import { PrismaService } from "../../database/prisma.service.js";
import {
  AI_SOURCE_LINEAGE,
  type AuthorizedSourceLineage,
  type AiSourceLineagePort,
} from "../../projects/application/ai-source-lineage.port.js";
import {
  AI_CUT_LINEAGE,
  type AiCutLineagePort,
  type ReadyCutLineage,
} from "../../media-pipeline/application/ai-cut-lineage.port.js";
import {
  CREATOR_URL_POLICY_VERSION,
  contextPolicyFingerprint,
  canonicalFingerprint,
  AI_OPERATION_CONTRACT_VERSION,
  encodeScopedCursor,
  type AiCapability,
} from "../domain/creator-context.js";
import {
  AiContentIdempotencyConflictError,
  AiContentPersistenceConflictError,
  AiContentRevisionConflictError,
  CreatorProfileNotFoundError,
  CreatorProfileUrlConflictError,
  CreatorReferenceNotFoundError,
  CreatorReferenceSelectionError,
  CutPromptLineageError,
  SourceContextLineageError,
  type AuthorizationDetail,
  type AuthorizationMutationInput,
  type CreatorContextRepository,
  type CreatorProfileDetail,
  type CreatorProfileRevisionView,
  type CreatorProfileSummary,
  type CreatorReferenceAssetView,
  type CreatorReferenceUploadClaim,
  type CutPromptDetail,
  type CutPromptMutationInput,
  type CutPromptRevisionView,
  type DefaultReferenceMutationInput,
  type LikenessUsability,
  type Page,
  type PageInput,
  type ProfileMutationInput,
  type ReferenceUploadRecord,
  type SourceContextDetail,
  type SourceContextMutationInput,
  type SourceContextRevisionView,
} from "../application/creator-context-repository.port.js";
import type {
  AiEditorialContextBlocker,
  AiEditorialContextChain,
  AiEditorialContextResolution,
} from "../application/resolve-ai-editorial-context.port.js";

type Transaction = Prisma.TransactionClient;

const profileRevisionInclude = {
  officialUrlIdentity: true,
  defaultReferenceAsset: {
    include: {
      authorizations: { orderBy: { revision: "desc" as const }, take: 1 },
    },
  },
  defaultReferenceAuthorization: true,
} as const;

type ProfileRevisionRow = Prisma.CreatorProfileRevisionGetPayload<{
  include: typeof profileRevisionInclude;
}>;

const sourceRevisionInclude = {
  creatorProfile: true,
  creatorProfileRevision: { include: profileRevisionInclude },
  context: true,
} as const;

type SourceRevisionRow = Prisma.SourceEditorialContextRevisionGetPayload<{
  include: typeof sourceRevisionInclude;
}>;

const promptRevisionInclude = {
  prompt: true,
  sourceContextRevision: { include: sourceRevisionInclude },
} as const;

type PromptRevisionRow = Prisma.CutEditorialPromptRevisionGetPayload<{
  include: typeof promptRevisionInclude;
}>;

@Injectable()
export class PrismaCreatorContextRepository implements CreatorContextRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AI_SOURCE_LINEAGE)
    private readonly sourceLineage: AiSourceLineagePort,
    @Inject(AI_CUT_LINEAGE)
    private readonly cutLineage: AiCutLineagePort,
  ) {}

  async createProfile(
    input: ProfileMutationInput & {
      profileId: string;
      revisionId: string;
      urlIdentityId: string;
    },
  ): Promise<CreatorProfileDetail> {
    return this.serializable(async (transaction) => {
      const replay = await this.replay(
        transaction,
        input,
        "CREATE_CREATOR_PROFILE",
      );
      if (replay)
        return this.requireProfile(replay.resultId, undefined, transaction);
      const owner =
        await transaction.creatorProfileOfficialUrlIdentity.findUnique({
          where: {
            canonicalizationVersion_canonicalUrl: {
              canonicalizationVersion: CREATOR_URL_POLICY_VERSION,
              canonicalUrl: input.canonicalOfficialUrl,
            },
          },
        });
      if (owner)
        throw new CreatorProfileUrlConflictError(owner.creatorProfileId);
      await transaction.creatorProfile.create({
        data: { id: input.profileId, currentRevision: 1 },
      });
      await transaction.creatorProfileOfficialUrlIdentity.create({
        data: {
          id: input.urlIdentityId,
          creatorProfileId: input.profileId,
          canonicalizationVersion: CREATOR_URL_POLICY_VERSION,
          canonicalUrl: input.canonicalOfficialUrl,
        },
      });
      await transaction.creatorProfileRevision.create({
        data: this.profileRevisionData(input, 1, input.urlIdentityId),
      });
      await this.recordOperation(transaction, input, "CREATE_CREATOR_PROFILE", {
        type: "CREATOR_PROFILE",
        id: input.profileId,
        revision: 1,
        profileId: input.profileId,
      });
      return this.requireProfile(input.profileId, 1, transaction);
    });
  }

  async updateProfile(
    input: ProfileMutationInput & {
      profileId: string;
      expectedRevision: number;
      revisionId: string;
      urlIdentityId: string;
    },
  ): Promise<CreatorProfileDetail> {
    return this.serializable(async (transaction) => {
      const replay = await this.replay(
        transaction,
        input,
        "UPDATE_CREATOR_PROFILE",
      );
      if (replay)
        return this.requireProfile(
          replay.resultId,
          replay.resultRevision ?? undefined,
          transaction,
        );
      const profile = await transaction.creatorProfile.findUnique({
        where: { id: input.profileId },
      });
      if (!profile) throw new CreatorProfileNotFoundError();
      if (profile.currentRevision !== input.expectedRevision)
        throw new AiContentRevisionConflictError();
      const current = await transaction.creatorProfileRevision.findUnique({
        where: {
          creatorProfileId_revision: {
            creatorProfileId: input.profileId,
            revision: profile.currentRevision,
          },
        },
      });
      if (!current) throw new AiContentPersistenceConflictError();
      let identity =
        await transaction.creatorProfileOfficialUrlIdentity.findUnique({
          where: {
            canonicalizationVersion_canonicalUrl: {
              canonicalizationVersion: CREATOR_URL_POLICY_VERSION,
              canonicalUrl: input.canonicalOfficialUrl,
            },
          },
        });
      if (identity && identity.creatorProfileId !== input.profileId) {
        throw new CreatorProfileUrlConflictError(identity.creatorProfileId);
      }
      identity ??= await transaction.creatorProfileOfficialUrlIdentity.create({
        data: {
          id: input.urlIdentityId,
          creatorProfileId: input.profileId,
          canonicalizationVersion: CREATOR_URL_POLICY_VERSION,
          canonicalUrl: input.canonicalOfficialUrl,
        },
      });
      const nextRevision = input.expectedRevision + 1;
      await this.advanceProfile(
        transaction,
        input.profileId,
        input.expectedRevision,
      );
      await transaction.creatorProfileRevision.create({
        data: {
          ...this.profileRevisionData(input, nextRevision, identity.id),
          likenessPolicy: current.likenessPolicy,
          defaultReferenceAssetId: current.defaultReferenceAssetId,
          defaultReferenceAuthorizationRevisionId:
            current.defaultReferenceAuthorizationRevisionId,
          defaultReferenceAuthorizationRevision:
            current.defaultReferenceAuthorizationRevision,
        },
      });
      await this.recordOperation(transaction, input, "UPDATE_CREATOR_PROFILE", {
        type: "CREATOR_PROFILE",
        id: input.profileId,
        revision: nextRevision,
        profileId: input.profileId,
      });
      return this.requireProfile(input.profileId, nextRevision, transaction);
    });
  }

  async getProfile(
    profileId: string,
    revision?: number,
  ): Promise<CreatorProfileDetail | null> {
    return this.profile(profileId, revision, this.prisma);
  }

  async listProfiles(input: PageInput): Promise<Page<CreatorProfileSummary>> {
    const rows = await this.prisma.creatorProfile.findMany({
      where: input.cursor ? olderThan(input.cursor) : undefined,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      include: {
        revisions: {
          orderBy: { revision: "desc" },
          take: 1,
          include: profileRevisionInclude,
        },
      },
    });
    const items = rows.slice(0, input.limit).map((row) => {
      const revision = row.revisions[0];
      if (!revision) throw new AiContentPersistenceConflictError();
      const likeness = this.likenessUsability(revision, row.currentRevision);
      return {
        id: row.id,
        currentRevision: row.currentRevision,
        canonicalDisplayName: revision.canonicalDisplayName,
        officialUrl: revision.officialUrl,
        primaryLanguage: revision.primaryLanguage,
        topics: stringArray(revision.topics),
        likenessPolicy: revision.likenessPolicy,
        likenessAllowed: likeness.usable,
        updatedAt: row.updatedAt,
      };
    });
    return page(items, rows, input.limit, input.scope, (row) => ({
      createdAt: row.updatedAt,
      id: row.id,
    }));
  }

  async listProfileRevisions(
    profileId: string,
    input: PageInput,
  ): Promise<Page<CreatorProfileRevisionView>> {
    const profile = await this.prisma.creatorProfile.findUnique({
      where: { id: profileId },
    });
    if (!profile) throw new CreatorProfileNotFoundError();
    const rows = await this.prisma.creatorProfileRevision.findMany({
      where: {
        creatorProfileId: profileId,
        ...(input.cursor ? olderThanCreated(input.cursor) : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      include: profileRevisionInclude,
    });
    const items = rows
      .slice(0, input.limit)
      .map((row) => this.mapProfileRevision(row, profile.currentRevision));
    return page(items, rows, input.limit, input.scope, (row) => ({
      createdAt: row.createdAt,
      id: row.id,
    }));
  }

  async findReferenceUploadReplay(
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<CreatorReferenceAssetView | null> {
    const operation = await this.prisma.aiContentOperationRequest.findUnique({
      where: { idempotencyKey },
    });
    if (!operation) return null;
    if (
      operation.operation !== "UPLOAD_CREATOR_REFERENCE" ||
      operation.canonicalRequestFingerprint !== fingerprint
    ) {
      throw new AiContentIdempotencyConflictError();
    }
    return this.requireReference(operation.resultId, this.prisma);
  }

  async createPendingReference(
    input: ReferenceUploadRecord,
  ): Promise<CreatorReferenceUploadClaim> {
    return this.serializable(async (transaction) => {
      const replay = await this.replay(
        transaction,
        input,
        "UPLOAD_CREATOR_REFERENCE",
      );
      if (replay)
        return this.requireReferenceUploadClaim(
          replay.resultId,
          false,
          transaction,
        );
      const profile = await transaction.creatorProfile.findUnique({
        where: { id: input.creatorProfileId },
      });
      if (!profile) throw new CreatorProfileNotFoundError();
      await transaction.creatorReferenceAsset.create({
        data: {
          id: input.assetId,
          creatorProfileId: input.creatorProfileId,
          objectKey: input.objectKey,
          originalFilename: input.originalFilename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          width: input.width,
          height: input.height,
          authorizations: {
            create: {
              id: input.authorizationRevisionId,
              revision: 1,
              status: "NOT_REVIEWED",
            },
          },
        },
      });
      await this.recordOperation(
        transaction,
        input,
        "UPLOAD_CREATOR_REFERENCE",
        {
          type: "CREATOR_REFERENCE_ASSET",
          id: input.assetId,
          revision: 1,
          profileId: input.creatorProfileId,
          referenceAssetId: input.assetId,
        },
      );
      return this.requireReferenceUploadClaim(input.assetId, true, transaction);
    });
  }

  async finalizeReference(
    assetId: string,
    receipt: { etag?: string; version?: string },
  ): Promise<CreatorReferenceAssetView> {
    const updated = await this.prisma.creatorReferenceAsset.updateMany({
      where: { id: assetId, status: "PENDING" },
      data: {
        status: "READY",
        storageEtag: receipt.etag,
        storageVersion: receipt.version,
      },
    });
    if (updated.count !== 1) {
      const existing = await this.getReferenceFinalization(assetId);
      if (existing?.status === "READY") return existing;
      throw new AiContentPersistenceConflictError();
    }
    return this.requireReference(assetId, this.prisma);
  }

  async failReference(assetId: string, code: string): Promise<void> {
    const updated = await this.prisma.creatorReferenceAsset.updateMany({
      where: { id: assetId, status: "PENDING" },
      data: {
        status: "FAILED_FINAL",
        failureCode: code,
        cleanupStatus: "PENDING",
        cleanupRequestedAt: new Date(),
      },
    });
    if (updated.count !== 1) throw new AiContentPersistenceConflictError();
  }

  async completeReferenceCleanup(assetId: string): Promise<void> {
    await this.prisma.creatorReferenceAsset.updateMany({
      where: { id: assetId, cleanupStatus: "PENDING" },
      data: { cleanupStatus: "COMPLETED", cleanupCompletedAt: new Date() },
    });
  }

  async recordReferenceCleanupFailure(
    assetId: string,
    code: string,
  ): Promise<void> {
    await this.prisma.creatorReferenceAsset.updateMany({
      where: { id: assetId, cleanupStatus: "PENDING" },
      data: {
        cleanupAttemptCount: { increment: 1 },
        cleanupLastErrorCode: code,
      },
    });
  }

  async listRecoverableReferences(input: { staleBefore: Date; limit: number }) {
    const rows = await this.prisma.creatorReferenceAsset.findMany({
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

  async getReferenceFinalization(
    assetId: string,
  ): Promise<CreatorReferenceAssetView | null> {
    const row = await this.referenceRow(assetId, this.prisma);
    return row ? this.mapReference(row) : null;
  }

  async getReference(profileId: string, assetId: string) {
    const row = await this.referenceRow(assetId, this.prisma);
    if (!row || row.creatorProfileId !== profileId || row.status !== "READY")
      return null;
    return { asset: this.mapReference(row), objectKey: row.objectKey };
  }

  async listReferences(
    profileId: string,
    input: PageInput,
  ): Promise<Page<CreatorReferenceAssetView>> {
    const profile = await this.prisma.creatorProfile.findUnique({
      where: { id: profileId },
    });
    if (!profile) throw new CreatorProfileNotFoundError();
    const rows = await this.prisma.creatorReferenceAsset.findMany({
      where: {
        creatorProfileId: profileId,
        ...(input.cursor ? olderThanCreated(input.cursor) : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      include: {
        authorizations: { orderBy: { revision: "desc" }, take: 1 },
      },
    });
    const items = rows
      .slice(0, input.limit)
      .map((row) => this.mapReference(row));
    return page(items, rows, input.limit, input.scope, (row) => ({
      createdAt: row.createdAt,
      id: row.id,
    }));
  }

  async updateAuthorization(
    input: AuthorizationMutationInput,
  ): Promise<AuthorizationDetail> {
    return this.serializable(async (transaction) => {
      const replay = await this.replay(
        transaction,
        input,
        "UPDATE_CREATOR_REFERENCE_AUTHORIZATION",
      );
      if (replay)
        return this.requireAuthorizationAt(
          input.creatorProfileId,
          input.assetId,
          replay.resultRevision ?? 0,
          transaction,
        );
      const asset = await transaction.creatorReferenceAsset.findFirst({
        where: { id: input.assetId, creatorProfileId: input.creatorProfileId },
        include: {
          authorizations: { orderBy: { revision: "desc" }, take: 1 },
        },
      });
      if (!asset) throw new CreatorReferenceNotFoundError();
      const current = asset.authorizations[0];
      if (
        !current ||
        asset.currentAuthorizationRevision !== input.expectedRevision
      )
        throw new AiContentRevisionConflictError();
      if (input.decision === "REVOKED" && current.status === "REVOKED") {
        await this.recordOperation(
          transaction,
          input,
          "UPDATE_CREATOR_REFERENCE_AUTHORIZATION",
          {
            type: "CREATOR_REFERENCE_AUTHORIZATION",
            id: current.id,
            revision: current.revision,
            profileId: input.creatorProfileId,
            referenceAssetId: input.assetId,
          },
        );
        return this.requireAuthorization(
          input.creatorProfileId,
          input.assetId,
          transaction,
        );
      }
      if (asset.status !== "READY")
        throw new CreatorReferenceSelectionError("CREATOR_REFERENCE_NOT_READY");
      const nextRevision = input.expectedRevision + 1;
      const advanced = await transaction.creatorReferenceAsset.updateMany({
        where: {
          id: input.assetId,
          creatorProfileId: input.creatorProfileId,
          currentAuthorizationRevision: input.expectedRevision,
        },
        data: { currentAuthorizationRevision: nextRevision },
      });
      if (advanced.count !== 1) throw new AiContentRevisionConflictError();
      await transaction.creatorReferenceAuthorizationRevision.create({
        data: {
          id: input.authorizationRevisionId,
          referenceAssetId: input.assetId,
          revision: nextRevision,
          status: input.decision,
          declarationVersion: input.declarationVersion,
          commercialAiImageUseAttested: input.commercialAiImageUseAttested,
          basis: input.basis,
          scope: input.scope,
          expiresAt: input.expiresAt,
          externalProviderTransferAllowed:
            input.externalProviderTransferAllowed,
          decidedAt: new Date(),
        },
      });
      await this.recordOperation(
        transaction,
        input,
        "UPDATE_CREATOR_REFERENCE_AUTHORIZATION",
        {
          type: "CREATOR_REFERENCE_AUTHORIZATION",
          id: input.authorizationRevisionId,
          revision: nextRevision,
          profileId: input.creatorProfileId,
          referenceAssetId: input.assetId,
        },
      );
      return this.requireAuthorization(
        input.creatorProfileId,
        input.assetId,
        transaction,
      );
    });
  }

  async getAuthorization(
    profileId: string,
    assetId: string,
  ): Promise<AuthorizationDetail | null> {
    const asset = await this.prisma.creatorReferenceAsset.findFirst({
      where: { id: assetId, creatorProfileId: profileId },
      include: {
        authorizations: { orderBy: { revision: "desc" }, take: 100 },
      },
    });
    return asset ? this.mapAuthorizationDetail(asset) : null;
  }

  async setDefaultReference(
    input: DefaultReferenceMutationInput,
  ): Promise<CreatorProfileDetail> {
    return this.serializable(async (transaction) => {
      const replay = await this.replay(
        transaction,
        input,
        "SET_DEFAULT_CREATOR_REFERENCE",
      );
      if (replay)
        return this.requireProfile(
          input.profileId,
          replay.resultRevision ?? undefined,
          transaction,
        );
      const profile = await transaction.creatorProfile.findUnique({
        where: { id: input.profileId },
      });
      if (!profile) throw new CreatorProfileNotFoundError();
      if (profile.currentRevision !== input.expectedProfileRevision)
        throw new AiContentRevisionConflictError();
      const current = await transaction.creatorProfileRevision.findUnique({
        where: {
          creatorProfileId_revision: {
            creatorProfileId: input.profileId,
            revision: input.expectedProfileRevision,
          },
        },
      });
      if (!current) throw new AiContentPersistenceConflictError();
      let selected:
        | {
            assetId: string;
            authorizationId: string;
            authorizationRevision: number;
          }
        | undefined;
      if (input.selection.action === "SET") {
        const selection = input.selection;
        const asset = await transaction.creatorReferenceAsset.findFirst({
          where: {
            id: selection.assetId,
            creatorProfileId: input.profileId,
          },
          include: { authorizations: true },
        });
        if (!asset) throw new CreatorReferenceNotFoundError();
        const authorization = asset.authorizations.find(
          (candidate) =>
            candidate.id === selection.authorizationRevisionId &&
            candidate.revision === selection.authorizationRevision,
        );
        if (
          asset.status !== "READY" ||
          asset.currentAuthorizationRevision !==
            selection.authorizationRevision ||
          !authorization ||
          authorization.status !== "CLEARED" ||
          authorization.commercialAiImageUseAttested !== true ||
          (authorization.expiresAt !== null &&
            authorization.expiresAt <= new Date())
        ) {
          throw new CreatorReferenceSelectionError(
            "CREATOR_REFERENCE_AUTHORIZATION_NOT_USABLE",
          );
        }
        selected = {
          assetId: asset.id,
          authorizationId: authorization.id,
          authorizationRevision: authorization.revision,
        };
      }
      const nextRevision = input.expectedProfileRevision + 1;
      await this.advanceProfile(
        transaction,
        input.profileId,
        input.expectedProfileRevision,
      );
      await transaction.creatorProfileRevision.create({
        data: {
          id: input.revisionId,
          creatorProfileId: input.profileId,
          revision: nextRevision,
          canonicalDisplayName: current.canonicalDisplayName,
          officialUrlIdentityId: current.officialUrlIdentityId,
          officialUrl: current.officialUrl,
          primaryLanguage: current.primaryLanguage,
          topics: current.topics as Prisma.InputJsonValue,
          editorialNotes: current.editorialNotes,
          restrictions: current.restrictions as Prisma.InputJsonValue,
          likenessPolicy: selected
            ? "CLEARED_REFERENCE_ONLY"
            : "NO_REALISTIC_LIKENESS",
          defaultReferenceAssetId: selected?.assetId,
          defaultReferenceAuthorizationRevisionId: selected?.authorizationId,
          defaultReferenceAuthorizationRevision:
            selected?.authorizationRevision,
        },
      });
      await this.recordOperation(
        transaction,
        input,
        "SET_DEFAULT_CREATOR_REFERENCE",
        {
          type: "CREATOR_PROFILE",
          id: input.profileId,
          revision: nextRevision,
          profileId: input.profileId,
          referenceAssetId: selected?.assetId,
        },
      );
      return this.requireProfile(input.profileId, nextRevision, transaction);
    });
  }

  async putSourceContext(
    input: SourceContextMutationInput,
  ): Promise<SourceContextDetail> {
    const source = await this.sourceLineage.resolveAuthorizedSource(
      input.projectId,
      input.sourceId,
      input.sourceVersion,
    );
    if (!source) throw new SourceContextLineageError();
    return this.serializable(async (transaction) => {
      if (!(await this.sourceLeaseStillValid(transaction, source)))
        throw new SourceContextLineageError();
      const replay = await this.replay(
        transaction,
        input,
        "PUT_SOURCE_EDITORIAL_CONTEXT",
      );
      if (replay) {
        if (
          replay.resolvedProjectId !== input.projectId ||
          replay.resolvedSourceId !== input.sourceId ||
          replay.resolvedSourceVersion !== input.sourceVersion
        )
          throw new AiContentIdempotencyConflictError();
        return this.requireSourceContext(
          input.projectId,
          input.sourceId,
          input.sourceVersion,
          replay.resultRevision ?? undefined,
          transaction,
        );
      }
      const profile = await transaction.creatorProfile.findUnique({
        where: { id: input.editableRevision.creatorProfileId },
      });
      const profileRevision = profile
        ? await transaction.creatorProfileRevision.findUnique({
            where: {
              creatorProfileId_revision: {
                creatorProfileId: profile.id,
                revision: input.editableRevision.creatorProfileRevision,
              },
            },
          })
        : null;
      if (
        !profile ||
        !profileRevision ||
        profile.currentRevision !==
          input.editableRevision.creatorProfileRevision
      )
        throw new SourceContextLineageError();
      const current = await transaction.sourceEditorialContext.findUnique({
        where: {
          projectId_sourceId_sourceVersion: {
            projectId: input.projectId,
            sourceId: input.sourceId,
            sourceVersion: input.sourceVersion,
          },
        },
      });
      const nextRevision = input.expectedRevision + 1;
      const contextId = current?.id ?? input.contextId;
      if (!current) {
        if (input.expectedRevision !== 0)
          throw new AiContentRevisionConflictError();
        await transaction.sourceEditorialContext.create({
          data: {
            id: contextId,
            projectId: input.projectId,
            sourceId: input.sourceId,
            sourceVersion: input.sourceVersion,
            currentRevision: 1,
          },
        });
      } else {
        if (current.currentRevision !== input.expectedRevision)
          throw new AiContentRevisionConflictError();
        const advanced = await transaction.sourceEditorialContext.updateMany({
          where: { id: current.id, currentRevision: input.expectedRevision },
          data: { currentRevision: nextRevision },
        });
        if (advanced.count !== 1) throw new AiContentRevisionConflictError();
      }
      await transaction.sourceEditorialContextRevision.create({
        data: {
          id: input.revisionId,
          contextId,
          revision: nextRevision,
          projectId: input.projectId,
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          creatorProfileId: profile.id,
          creatorProfileRevisionId: profileRevision.id,
          creatorProfileRevisionNo: profileRevision.revision,
          sourceTitle: input.editableRevision.sourceTitle,
          gameOrTopic: input.editableRevision.gameOrTopic,
          audience: input.editableRevision.audience,
          editorialGoal: input.editableRevision.editorialGoal,
          language: input.editableRevision.language,
          defaultCta: input.editableRevision.defaultCta,
          restrictions: input.editableRevision.restrictions,
          operatorNotes: input.editableRevision.operatorNotes,
        },
      });
      await this.recordOperation(
        transaction,
        input,
        "PUT_SOURCE_EDITORIAL_CONTEXT",
        {
          type: "SOURCE_EDITORIAL_CONTEXT",
          id: contextId,
          revision: nextRevision,
          profileId: profile.id,
          projectId: input.projectId,
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
        },
      );
      return this.requireSourceContext(
        input.projectId,
        input.sourceId,
        input.sourceVersion,
        nextRevision,
        transaction,
      );
    });
  }

  async getSourceContext(
    projectId: string,
    sourceId: string,
    sourceVersion: number,
    revision?: number,
  ): Promise<SourceContextDetail | null> {
    const source = await this.sourceLineage.resolveAuthorizedSource(
      projectId,
      sourceId,
      sourceVersion,
    );
    if (!source) return null;
    return this.sourceContext(
      projectId,
      sourceId,
      sourceVersion,
      revision,
      this.prisma,
    );
  }

  async listSourceContextRevisions(
    projectId: string,
    sourceId: string,
    sourceVersion: number,
    input: PageInput,
  ): Promise<Page<SourceContextRevisionView>> {
    const source = await this.sourceLineage.resolveAuthorizedSource(
      projectId,
      sourceId,
      sourceVersion,
    );
    if (!source) throw new SourceContextLineageError();
    const context = await this.prisma.sourceEditorialContext.findUnique({
      where: {
        projectId_sourceId_sourceVersion: {
          projectId,
          sourceId,
          sourceVersion,
        },
      },
    });
    if (!context) throw new SourceContextLineageError();
    const rows = await this.prisma.sourceEditorialContextRevision.findMany({
      where: {
        contextId: context.id,
        ...(input.cursor ? olderThanCreated(input.cursor) : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      include: sourceRevisionInclude,
    });
    const items = rows
      .slice(0, input.limit)
      .map((row) => this.mapSourceRevision(row));
    return page(items, rows, input.limit, input.scope, (row) => ({
      createdAt: row.createdAt,
      id: row.id,
    }));
  }

  async putCutPrompt(input: CutPromptMutationInput): Promise<CutPromptDetail> {
    const cut = await this.cutLineage.resolveReadyCut(input.cutPipelineJobId);
    if (!cut) throw new CutPromptLineageError();
    return this.serializable(async (transaction) => {
      if (!(await this.cutLeaseStillValid(transaction, cut)))
        throw new CutPromptLineageError();
      const context = await transaction.sourceEditorialContext.findUnique({
        where: { id: input.editableRevision.sourceContextId },
      });
      const contextRevision = context
        ? await transaction.sourceEditorialContextRevision.findUnique({
            where: {
              contextId_revision: {
                contextId: context.id,
                revision: input.editableRevision.sourceContextRevision,
              },
            },
            include: { creatorProfile: true },
          })
        : null;
      if (
        !context ||
        !contextRevision ||
        context.projectId !== cut.projectId ||
        context.sourceId !== cut.sourceId ||
        context.sourceVersion !== cut.sourceVersion ||
        context.currentRevision !== contextRevision.revision ||
        contextRevision.creatorProfile.currentRevision !==
          contextRevision.creatorProfileRevisionNo
      )
        throw new CutPromptLineageError();
      const resolvedInput = {
        ...input,
        requestFingerprint: cutPromptRequestFingerprint(
          input,
          cut,
          contextRevision,
        ),
      };
      const replay = await this.replay(
        transaction,
        resolvedInput,
        "PUT_CUT_EDITORIAL_PROMPT",
      );
      if (replay) {
        if (
          replay.resolvedProjectId !== cut.projectId ||
          replay.resolvedSourceId !== cut.sourceId ||
          replay.resolvedSourceVersion !== cut.sourceVersion
        )
          throw new AiContentIdempotencyConflictError();
        return this.requireCutPrompt(
          input.cutPipelineJobId,
          replay.resultRevision ?? undefined,
          transaction,
        );
      }
      const current = await transaction.cutEditorialPrompt.findUnique({
        where: { cutPipelineJobId: input.cutPipelineJobId },
      });
      const nextRevision = input.expectedRevision + 1;
      const promptId = current?.id ?? input.promptId;
      if (!current) {
        if (input.expectedRevision !== 0)
          throw new AiContentRevisionConflictError();
        await transaction.cutEditorialPrompt.create({
          data: {
            id: promptId,
            cutPipelineJobId: input.cutPipelineJobId,
            projectId: cut.projectId,
            sourceId: cut.sourceId,
            sourceVersion: cut.sourceVersion,
            cutResultArtifactId: cut.resultArtifactId,
            cutResultSha256: cut.resultSha256,
            cutResultSizeBytes: cut.resultSizeBytes,
            currentRevision: 1,
          },
        });
      } else {
        if (
          current.currentRevision !== input.expectedRevision ||
          current.projectId !== cut.projectId ||
          current.sourceId !== cut.sourceId ||
          current.sourceVersion !== cut.sourceVersion ||
          current.cutResultArtifactId !== cut.resultArtifactId ||
          current.cutResultSha256 !== cut.resultSha256 ||
          current.cutResultSizeBytes !== cut.resultSizeBytes
        )
          throw new AiContentRevisionConflictError();
        const advanced = await transaction.cutEditorialPrompt.updateMany({
          where: { id: current.id, currentRevision: input.expectedRevision },
          data: { currentRevision: nextRevision },
        });
        if (advanced.count !== 1) throw new AiContentRevisionConflictError();
      }
      await transaction.cutEditorialPromptRevision.create({
        data: {
          id: input.revisionId,
          promptId,
          revision: nextRevision,
          projectId: cut.projectId,
          sourceId: cut.sourceId,
          sourceVersion: cut.sourceVersion,
          sourceContextId: context.id,
          sourceContextRevisionId: contextRevision.id,
          sourceContextRevisionNo: contextRevision.revision,
          whatHappens: input.editableRevision.whatHappens,
          desiredAngle: input.editableRevision.desiredAngle,
          tone: input.editableRevision.tone,
          cta: input.editableRevision.cta,
          restrictions: input.editableRevision.restrictions,
        },
      });
      await this.recordOperation(
        transaction,
        resolvedInput,
        "PUT_CUT_EDITORIAL_PROMPT",
        {
          type: "CUT_EDITORIAL_PROMPT",
          id: promptId,
          revision: nextRevision,
          projectId: cut.projectId,
          sourceId: cut.sourceId,
          sourceVersion: cut.sourceVersion,
        },
      );
      return this.requireCutPrompt(
        input.cutPipelineJobId,
        nextRevision,
        transaction,
      );
    });
  }

  async getCutPrompt(
    cutPipelineJobId: string,
    revision?: number,
  ): Promise<CutPromptDetail | null> {
    const cut = await this.cutLineage.resolveReadyCut(cutPipelineJobId);
    if (!cut) return null;
    return this.cutPrompt(cutPipelineJobId, revision, this.prisma);
  }

  async listCutPromptRevisions(
    cutPipelineJobId: string,
    input: PageInput,
  ): Promise<Page<CutPromptRevisionView>> {
    const cut = await this.cutLineage.resolveReadyCut(cutPipelineJobId);
    if (!cut) throw new CutPromptLineageError();
    const prompt = await this.prisma.cutEditorialPrompt.findUnique({
      where: { cutPipelineJobId },
    });
    if (!prompt) throw new CutPromptLineageError();
    const rows = await this.prisma.cutEditorialPromptRevision.findMany({
      where: {
        promptId: prompt.id,
        ...(input.cursor ? olderThanCreated(input.cursor) : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      include: promptRevisionInclude,
    });
    const items = rows
      .slice(0, input.limit)
      .map((row) => this.mapPromptRevision(row));
    return page(items, rows, input.limit, input.scope, (row) => ({
      createdAt: row.createdAt,
      id: row.id,
    }));
  }

  async resolveEditorialContext(
    cutPipelineJobId: string,
    capability: AiCapability,
  ): Promise<AiEditorialContextResolution> {
    const cut = await this.cutLineage.resolveReadyCut(cutPipelineJobId);
    if (!cut) return blockedResolution(capability, "CUT_LINEAGE_UNUSABLE");
    const prompt = await this.prisma.cutEditorialPrompt.findUnique({
      where: { cutPipelineJobId },
    });
    if (!prompt) return blockedResolution(capability, "CUT_PROMPT_MISSING");
    const row = await this.prisma.cutEditorialPromptRevision.findUnique({
      where: {
        promptId_revision: {
          promptId: prompt.id,
          revision: prompt.currentRevision,
        },
      },
      include: promptRevisionInclude,
    });
    if (!row) return blockedResolution(capability, "CUT_PROMPT_MISSING");
    const revision = this.mapPromptRevision(row);
    const profileRevision = row.sourceContextRevision.creatorProfileRevision;
    const asset = profileRevision.defaultReferenceAsset;
    const captured = profileRevision.defaultReferenceAuthorization;
    const latest = asset?.authorizations[0] ?? null;
    const reference =
      asset && captured
        ? {
            assetId: asset.id,
            assetStatus: asset.status,
            capturedAuthorizationRevisionId: captured.id,
            capturedAuthorizationRevision: captured.revision,
            latestAuthorizationRevisionId: latest?.id ?? null,
            latestAuthorizationRevision: latest?.revision ?? null,
            latestAuthorizationStatus: latest?.status ?? null,
            latestAuthorizationExpiresAt: latest?.expiresAt ?? null,
            externalProviderTransferAllowed:
              captured.externalProviderTransferAllowed,
          }
        : null;
    const chain: AiEditorialContextChain = {
      projectId: cut.projectId,
      source: {
        id: cut.sourceId,
        version: cut.sourceVersion,
        sha256: cut.sourceSha256,
        authorizationRevision: cut.authorizationRevision,
        authorizationBasis: cut.authorizationBasis,
        authorizationDeclarationVersion: cut.authorizationDeclarationVersion,
        authorizationDecidedAt: cut.authorizationDecidedAt,
      },
      cut: {
        pipelineJobId: cut.cutPipelineJobId,
        resultArtifactId: cut.resultArtifactId,
        resultSha256: cut.resultSha256,
        resultSizeBytes: cut.resultSizeBytes,
      },
      prompt: {
        id: prompt.id,
        revisionId: row.id,
        revision: row.revision,
        currentRevision: prompt.currentRevision,
      },
      sourceContext: {
        id: row.sourceContextId,
        revisionId: row.sourceContextRevisionId,
        revision: row.sourceContextRevisionNo,
        currentRevision: row.sourceContextRevision.context.currentRevision,
      },
      creatorProfile: {
        id: row.sourceContextRevision.creatorProfileId,
        revisionId: row.sourceContextRevision.creatorProfileRevisionId,
        revision: row.sourceContextRevision.creatorProfileRevisionNo,
        currentRevision:
          row.sourceContextRevision.creatorProfile.currentRevision,
      },
      reference,
    };
    const blockers = revision.blockers as AiEditorialContextBlocker[];
    if (!cutMatchesPrompt(cut, prompt)) blockers.push("CUT_LINEAGE_CHANGED");
    if (capability === "REALISTIC_LIKENESS_IMAGE")
      blockers.push(...resolverLikenessBlockers(profileRevision));
    const uniqueBlockers = [...new Set(blockers)];
    return {
      capability,
      admitted: uniqueBlockers.length === 0,
      blockers: uniqueBlockers,
      contextPolicyFingerprint: contextPolicyFingerprint({
        capability,
        chain: policyFingerprintChain(chain),
      }),
      chain,
    };
  }

  private async profile(
    profileId: string,
    revision: number | undefined,
    client: PrismaService | Transaction,
  ): Promise<CreatorProfileDetail | null> {
    const profile = await client.creatorProfile.findUnique({
      where: { id: profileId },
    });
    if (!profile) return null;
    const selected = await client.creatorProfileRevision.findUnique({
      where: {
        creatorProfileId_revision: {
          creatorProfileId: profileId,
          revision: revision ?? profile.currentRevision,
        },
      },
      include: profileRevisionInclude,
    });
    if (!selected) return null;
    return {
      id: profile.id,
      currentRevision: profile.currentRevision,
      revision: this.mapProfileRevision(selected, profile.currentRevision),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  private async requireProfile(
    profileId: string,
    revision: number | undefined,
    client: PrismaService | Transaction,
  ): Promise<CreatorProfileDetail> {
    const found = await this.profile(profileId, revision, client);
    if (!found) throw new AiContentPersistenceConflictError();
    return found;
  }

  private async requireReferenceUploadClaim(
    assetId: string,
    ownsUpload: boolean,
    client: PrismaService | Transaction,
  ): Promise<CreatorReferenceUploadClaim> {
    const row = await this.referenceRow(assetId, client);
    if (!row) throw new AiContentPersistenceConflictError();
    return {
      asset: this.mapReference(row),
      objectKey: row.objectKey,
      ownsUpload,
    };
  }

  private async sourceContext(
    projectId: string,
    sourceId: string,
    sourceVersion: number,
    revision: number | undefined,
    client: PrismaService | Transaction,
  ): Promise<SourceContextDetail | null> {
    const context = await client.sourceEditorialContext.findUnique({
      where: {
        projectId_sourceId_sourceVersion: {
          projectId,
          sourceId,
          sourceVersion,
        },
      },
    });
    if (!context) return null;
    const selected = await client.sourceEditorialContextRevision.findUnique({
      where: {
        contextId_revision: {
          contextId: context.id,
          revision: revision ?? context.currentRevision,
        },
      },
      include: sourceRevisionInclude,
    });
    if (!selected) return null;
    return {
      id: context.id,
      currentRevision: context.currentRevision,
      revision: this.mapSourceRevision(selected),
      createdAt: context.createdAt,
      updatedAt: context.updatedAt,
    };
  }

  private async requireSourceContext(
    projectId: string,
    sourceId: string,
    sourceVersion: number,
    revision: number | undefined,
    client: PrismaService | Transaction,
  ): Promise<SourceContextDetail> {
    const found = await this.sourceContext(
      projectId,
      sourceId,
      sourceVersion,
      revision,
      client,
    );
    if (!found) throw new AiContentPersistenceConflictError();
    return found;
  }

  private async cutPrompt(
    cutPipelineJobId: string,
    revision: number | undefined,
    client: PrismaService | Transaction,
  ): Promise<CutPromptDetail | null> {
    const prompt = await client.cutEditorialPrompt.findUnique({
      where: { cutPipelineJobId },
    });
    if (!prompt) return null;
    const selected = await client.cutEditorialPromptRevision.findUnique({
      where: {
        promptId_revision: {
          promptId: prompt.id,
          revision: revision ?? prompt.currentRevision,
        },
      },
      include: promptRevisionInclude,
    });
    if (!selected) return null;
    return {
      id: prompt.id,
      currentRevision: prompt.currentRevision,
      revision: this.mapPromptRevision(selected),
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };
  }

  private async requireCutPrompt(
    cutPipelineJobId: string,
    revision: number | undefined,
    client: PrismaService | Transaction,
  ): Promise<CutPromptDetail> {
    const found = await this.cutPrompt(cutPipelineJobId, revision, client);
    if (!found) throw new AiContentPersistenceConflictError();
    return found;
  }

  private async referenceRow(
    assetId: string,
    client: PrismaService | Transaction,
  ) {
    return client.creatorReferenceAsset.findUnique({
      where: { id: assetId },
      include: {
        authorizations: { orderBy: { revision: "desc" }, take: 1 },
      },
    });
  }

  private async requireReference(
    assetId: string,
    client: PrismaService | Transaction,
  ): Promise<CreatorReferenceAssetView> {
    const row = await this.referenceRow(assetId, client);
    if (!row) throw new AiContentPersistenceConflictError();
    return this.mapReference(row);
  }

  private async requireAuthorization(
    profileId: string,
    assetId: string,
    client: PrismaService | Transaction,
  ): Promise<AuthorizationDetail> {
    const row = await client.creatorReferenceAsset.findFirst({
      where: { id: assetId, creatorProfileId: profileId },
      include: {
        authorizations: { orderBy: { revision: "desc" }, take: 100 },
      },
    });
    if (!row) throw new CreatorReferenceNotFoundError();
    return this.mapAuthorizationDetail(row);
  }

  private async requireAuthorizationAt(
    profileId: string,
    assetId: string,
    revision: number,
    client: PrismaService | Transaction,
  ): Promise<AuthorizationDetail> {
    const row = await client.creatorReferenceAsset.findFirst({
      where: { id: assetId, creatorProfileId: profileId },
    });
    if (!row) throw new CreatorReferenceNotFoundError();
    const history = (
      await client.creatorReferenceAuthorizationRevision.findMany({
        where: { referenceAssetId: assetId, revision: { lte: revision } },
        orderBy: { revision: "desc" },
        take: 100,
      })
    ).map(mapAuthorization);
    const current = history.find(
      (candidate) => candidate.revision === revision,
    );
    if (!current) throw new AiContentPersistenceConflictError();
    return {
      assetId,
      creatorProfileId: profileId,
      currentRevision: revision,
      current,
      history,
    };
  }

  private mapProfileRevision(
    row: ProfileRevisionRow,
    currentRevision: number,
  ): CreatorProfileRevisionView {
    const usability = this.likenessUsability(row, currentRevision);
    const captured = row.defaultReferenceAuthorization;
    return {
      id: row.id,
      profileId: row.creatorProfileId,
      revision: row.revision,
      editableRevision: {
        canonicalDisplayName: row.canonicalDisplayName,
        officialUrl: row.officialUrl,
        primaryLanguage: row.primaryLanguage,
        topics: stringArray(row.topics),
        editorialNotes: row.editorialNotes,
        restrictions: stringArray(row.restrictions),
      },
      officialUrlIdentity: {
        id: row.officialUrlIdentity.id,
        canonicalizationVersion:
          row.officialUrlIdentity.canonicalizationVersion,
        canonicalUrl: row.officialUrlIdentity.canonicalUrl,
      },
      likenessPolicy: row.likenessPolicy,
      defaultReference:
        row.defaultReferenceAsset && captured
          ? {
              assetId: row.defaultReferenceAsset.id,
              authorizationRevisionId: captured.id,
              authorizationRevision: captured.revision,
              authorizationStatus: captured.status,
              expiresAt: captured.expiresAt,
              externalProviderTransferAllowed:
                captured.externalProviderTransferAllowed,
            }
          : null,
      status: row.revision === currentRevision ? "CURRENT" : "STALE",
      likenessUsability: usability,
      createdAt: row.createdAt,
    };
  }

  private likenessUsability(
    row: ProfileRevisionRow,
    currentRevision: number,
  ): LikenessUsability {
    if (row.revision !== currentRevision)
      return unusable("CREATOR_PROFILE_REVISION_STALE");
    if (row.likenessPolicy !== "CLEARED_REFERENCE_ONLY")
      return unusable("REALISTIC_LIKENESS_NOT_SELECTED");
    const asset = row.defaultReferenceAsset;
    const captured = row.defaultReferenceAuthorization;
    if (!asset || !captured) return unusable("DEFAULT_REFERENCE_MISSING");
    if (asset.status !== "READY")
      return unusable("DEFAULT_REFERENCE_NOT_READY");
    const latest = asset.authorizations[0];
    if (!latest) return unusable("DEFAULT_REFERENCE_AUTHORIZATION_MISSING");
    if (latest.status === "REVOKED")
      return unusable("DEFAULT_REFERENCE_AUTHORIZATION_REVOKED");
    if (latest.expiresAt !== null && latest.expiresAt <= new Date())
      return unusable("DEFAULT_REFERENCE_AUTHORIZATION_EXPIRED");
    if (latest.id !== captured.id || latest.revision !== captured.revision)
      return unusable("DEFAULT_REFERENCE_AUTHORIZATION_CHANGED");
    if (
      captured.status !== "CLEARED" ||
      captured.commercialAiImageUseAttested !== true
    )
      return unusable("DEFAULT_REFERENCE_AUTHORIZATION_NOT_CLEARED");
    return {
      usable: true,
      blocker: null,
      externalProviderTransferAllowed: captured.externalProviderTransferAllowed,
    };
  }

  private mapReference(
    row: CreatorReferenceAsset & {
      authorizations: CreatorReferenceAuthorizationRevision[];
    },
  ): CreatorReferenceAssetView {
    const current = row.authorizations.find(
      (candidate) => candidate.revision === row.currentAuthorizationRevision,
    );
    if (!current || !isImageType(row.contentType))
      throw new AiContentPersistenceConflictError();
    return {
      id: row.id,
      creatorProfileId: row.creatorProfileId,
      status: row.status,
      originalFilename: row.originalFilename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      width: row.width,
      height: row.height,
      currentAuthorization: mapAuthorization(current),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapAuthorizationDetail(
    row: CreatorReferenceAsset & {
      authorizations: CreatorReferenceAuthorizationRevision[];
    },
  ): AuthorizationDetail {
    const history = row.authorizations.map(mapAuthorization);
    const current = history.find(
      (candidate) => candidate.revision === row.currentAuthorizationRevision,
    );
    if (!current) throw new AiContentPersistenceConflictError();
    return {
      assetId: row.id,
      creatorProfileId: row.creatorProfileId,
      currentRevision: row.currentAuthorizationRevision,
      current,
      history,
    };
  }

  private mapSourceRevision(row: SourceRevisionRow): SourceContextRevisionView {
    const profileCurrent =
      row.creatorProfile.currentRevision === row.creatorProfileRevisionNo;
    const contextCurrent = row.context.currentRevision === row.revision;
    const likeness = this.likenessUsability(
      row.creatorProfileRevision,
      row.creatorProfile.currentRevision,
    );
    const blockers = [
      ...(contextCurrent ? [] : ["SOURCE_CONTEXT_REVISION_STALE"]),
      ...(profileCurrent ? [] : ["CREATOR_PROFILE_REVISION_STALE"]),
    ];
    return {
      id: row.id,
      contextId: row.contextId,
      revision: row.revision,
      projectId: row.projectId,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
      editableRevision: {
        creatorProfileId: row.creatorProfileId,
        creatorProfileRevision: row.creatorProfileRevisionNo,
        sourceTitle: row.sourceTitle,
        gameOrTopic: row.gameOrTopic,
        audience: row.audience,
        editorialGoal: row.editorialGoal,
        language: row.language,
        defaultCta: row.defaultCta,
        restrictions: stringArray(row.restrictions),
        operatorNotes: row.operatorNotes,
      },
      creatorProfileRevisionId: row.creatorProfileRevisionId,
      status: blockers.length === 0 ? "CURRENT" : "STALE",
      blockers,
      likenessUsability: likeness,
      createdAt: row.createdAt,
    };
  }

  private mapPromptRevision(row: PromptRevisionRow): CutPromptRevisionView {
    const source = this.mapSourceRevision(row.sourceContextRevision);
    const promptCurrent = row.prompt.currentRevision === row.revision;
    const blockers = [
      ...(promptCurrent ? [] : ["CUT_PROMPT_REVISION_STALE"]),
      ...source.blockers,
    ];
    return {
      id: row.id,
      promptId: row.promptId,
      revision: row.revision,
      projectId: row.prompt.projectId,
      sourceId: row.prompt.sourceId,
      sourceVersion: row.prompt.sourceVersion,
      cutPipelineJobId: row.prompt.cutPipelineJobId,
      cutResultArtifact: {
        id: row.prompt.cutResultArtifactId,
        sha256: row.prompt.cutResultSha256,
        sizeBytes: row.prompt.cutResultSizeBytes,
      },
      editableRevision: {
        sourceContextId: row.sourceContextId,
        sourceContextRevision: row.sourceContextRevisionNo,
        whatHappens: row.whatHappens,
        desiredAngle: row.desiredAngle,
        tone: row.tone,
        cta: row.cta,
        restrictions: stringArray(row.restrictions),
      },
      sourceContextRevisionId: row.sourceContextRevisionId,
      status: blockers.length === 0 ? "CURRENT" : "STALE",
      blockers,
      likenessUsability: source.likenessUsability,
      contextPolicyFingerprint: contextPolicyFingerprint({
        profileRevisionId: row.sourceContextRevision.creatorProfileRevisionId,
        profileRevision: row.sourceContextRevision.creatorProfileRevisionNo,
        sourceContextRevisionId: row.sourceContextRevisionId,
        sourceContextRevision: row.sourceContextRevisionNo,
        cutPromptRevisionId: row.id,
        cutPromptRevision: row.revision,
        referenceAuthorizationRevisionId:
          row.sourceContextRevision.creatorProfileRevision
            .defaultReferenceAuthorizationRevisionId,
        latestReferenceAuthorizationRevision:
          row.sourceContextRevision.creatorProfileRevision.defaultReferenceAsset
            ?.currentAuthorizationRevision ?? null,
      }),
      createdAt: row.createdAt,
    };
  }

  private profileRevisionData(
    input: ProfileMutationInput & { profileId: string; revisionId: string },
    revision: number,
    officialUrlIdentityId: string,
  ) {
    return {
      id: input.revisionId,
      creatorProfileId: input.profileId,
      revision,
      canonicalDisplayName: input.editableRevision.canonicalDisplayName,
      officialUrlIdentityId,
      officialUrl: input.canonicalOfficialUrl,
      primaryLanguage: input.editableRevision.primaryLanguage,
      topics: input.editableRevision.topics,
      editorialNotes: input.editableRevision.editorialNotes,
      restrictions: input.editableRevision.restrictions,
      likenessPolicy: "NO_REALISTIC_LIKENESS" as const,
    };
  }

  private async advanceProfile(
    transaction: Transaction,
    profileId: string,
    expectedRevision: number,
  ): Promise<void> {
    const advanced = await transaction.creatorProfile.updateMany({
      where: { id: profileId, currentRevision: expectedRevision },
      data: { currentRevision: expectedRevision + 1 },
    });
    if (advanced.count !== 1) throw new AiContentRevisionConflictError();
  }

  private async sourceLeaseStillValid(
    transaction: Transaction,
    source: AuthorizedSourceLineage,
  ): Promise<boolean> {
    const current = await transaction.videoSource.findFirst({
      where: {
        id: source.sourceId,
        projectId: source.projectId,
        sourceVersion: source.sourceVersion,
        status: "READY",
        sha256: source.sourceSha256,
      },
      include: { authorizations: true },
    });
    const authorization = current?.authorizations.find(
      (candidate) => candidate.sourceVersion === source.sourceVersion,
    );
    return Boolean(
      current &&
      authorization &&
      authorization.status === "CLEARED" &&
      authorization.revision === source.authorizationRevision &&
      authorization.basis === source.authorizationBasis &&
      authorization.declarationVersion ===
        source.authorizationDeclarationVersion &&
      authorization.decidedAt?.getTime() ===
        source.authorizationDecidedAt.getTime(),
    );
  }

  private async cutLeaseStillValid(
    transaction: Transaction,
    cut: ReadyCutLineage,
  ): Promise<boolean> {
    const job = await transaction.pipelineJob.findFirst({
      where: {
        id: cut.cutPipelineJobId,
        projectId: cut.projectId,
        sourceId: cut.sourceId,
        sourceVersion: cut.sourceVersion,
        type: "CUT_SEGMENT",
        state: "READY",
      },
      include: { resultArtifact: true },
    });
    const artifact = job?.resultArtifact;
    if (
      !artifact ||
      artifact.id !== cut.resultArtifactId ||
      artifact.status !== "READY" ||
      artifact.role !== "CUT_RESULT" ||
      artifact.sha256 !== cut.resultSha256 ||
      artifact.sizeBytes !== cut.resultSizeBytes ||
      artifact.lineageSourceId !== cut.sourceId ||
      artifact.lineageSourceVersion !== cut.sourceVersion ||
      artifact.pipelineJobId !== cut.cutPipelineJobId
    )
      return false;
    return this.sourceLeaseStillValid(transaction, cut);
  }

  private async replay(
    transaction: Transaction,
    input: { idempotencyKey: string; requestFingerprint: string },
    operation: AiContentOperationType,
  ) {
    const row = await transaction.aiContentOperationRequest.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (
      row &&
      (row.operation !== operation ||
        row.canonicalRequestFingerprint !== input.requestFingerprint)
    )
      throw new AiContentIdempotencyConflictError();
    return row;
  }

  private async recordOperation(
    transaction: Transaction,
    input: {
      operationId: string;
      idempotencyKey: string;
      requestFingerprint: string;
    },
    operation: AiContentOperationType,
    result: {
      type: string;
      id: string;
      revision: number;
      profileId?: string;
      referenceAssetId?: string;
      projectId?: string;
      sourceId?: string;
      sourceVersion?: number;
    },
  ) {
    await transaction.aiContentOperationRequest.create({
      data: {
        id: input.operationId,
        idempotencyKey: input.idempotencyKey,
        operation,
        canonicalRequestFingerprint: input.requestFingerprint,
        resolvedProjectId: result.projectId,
        resolvedSourceId: result.sourceId,
        resolvedSourceVersion: result.sourceVersion,
        creatorProfileId: result.profileId,
        referenceAssetId: result.referenceAssetId,
        resultType: result.type,
        resultId: result.id,
        resultRevision: result.revision,
      },
    });
  }

  private async serializable<T>(
    action: (transaction: Transaction) => Promise<T>,
    attempt = 0,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(action, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (
        error instanceof AiContentIdempotencyConflictError ||
        error instanceof CreatorProfileNotFoundError ||
        error instanceof CreatorProfileUrlConflictError ||
        error instanceof AiContentRevisionConflictError ||
        error instanceof CreatorReferenceNotFoundError ||
        error instanceof CreatorReferenceSelectionError ||
        error instanceof SourceContextLineageError ||
        error instanceof CutPromptLineageError ||
        error instanceof AiContentPersistenceConflictError
      )
        throw error;
      if (isConflict(error) && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        return this.serializable(action, attempt + 1);
      }
      if (isConflict(error)) throw new AiContentRevisionConflictError();
      throw error;
    }
  }
}

function olderThan(cursor: { createdAt: Date; id: string }) {
  return {
    OR: [
      { updatedAt: { lt: cursor.createdAt } },
      { updatedAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function cutPromptRequestFingerprint(
  input: CutPromptMutationInput,
  cut: ReadyCutLineage,
  contextRevision: {
    id: string;
    contextId: string;
    revision: number;
    creatorProfileId: string;
    creatorProfileRevisionId: string;
    creatorProfileRevisionNo: number;
  },
): string {
  return canonicalFingerprint({
    contractVersion: AI_OPERATION_CONTRACT_VERSION,
    operation: "PUT_CUT_EDITORIAL_PROMPT",
    body: {
      cutPipelineJobId: input.cutPipelineJobId,
      expectedRevision: input.expectedRevision,
      editableRevision: input.editableRevision,
      resolvedLineage: {
        projectId: cut.projectId,
        sourceId: cut.sourceId,
        sourceVersion: cut.sourceVersion,
        sourceSha256: cut.sourceSha256,
        sourceAuthorizationRevision: cut.authorizationRevision,
        sourceAuthorizationBasis: cut.authorizationBasis,
        sourceAuthorizationDeclarationVersion:
          cut.authorizationDeclarationVersion,
        sourceAuthorizationDecidedAt: cut.authorizationDecidedAt.toISOString(),
        cutResultArtifactId: cut.resultArtifactId,
        cutResultSha256: cut.resultSha256,
        cutResultSizeBytes: cut.resultSizeBytes.toString(),
        sourceContextId: contextRevision.contextId,
        sourceContextRevisionId: contextRevision.id,
        sourceContextRevision: contextRevision.revision,
        creatorProfileId: contextRevision.creatorProfileId,
        creatorProfileRevisionId: contextRevision.creatorProfileRevisionId,
        creatorProfileRevision: contextRevision.creatorProfileRevisionNo,
      },
    },
  });
}

function cutMatchesPrompt(
  cut: ReadyCutLineage,
  prompt: {
    projectId: string;
    sourceId: string;
    sourceVersion: number;
    cutResultArtifactId: string;
    cutResultSha256: string;
    cutResultSizeBytes: bigint;
  },
): boolean {
  return (
    prompt.projectId === cut.projectId &&
    prompt.sourceId === cut.sourceId &&
    prompt.sourceVersion === cut.sourceVersion &&
    prompt.cutResultArtifactId === cut.resultArtifactId &&
    prompt.cutResultSha256 === cut.resultSha256 &&
    prompt.cutResultSizeBytes === cut.resultSizeBytes
  );
}

function resolverLikenessBlockers(
  revision: ProfileRevisionRow,
): AiEditorialContextBlocker[] {
  if (revision.likenessPolicy !== "CLEARED_REFERENCE_ONLY")
    return ["REALISTIC_LIKENESS_NOT_SELECTED"];
  const asset = revision.defaultReferenceAsset;
  const captured = revision.defaultReferenceAuthorization;
  if (!asset || !captured) return ["DEFAULT_REFERENCE_MISSING"];
  if (asset.status !== "READY") return ["DEFAULT_REFERENCE_NOT_READY"];
  const latest = asset.authorizations[0];
  if (!latest) return ["DEFAULT_REFERENCE_AUTHORIZATION_MISSING"];
  if (latest.status === "REVOKED")
    return ["DEFAULT_REFERENCE_AUTHORIZATION_REVOKED"];
  if (latest.expiresAt !== null && latest.expiresAt <= new Date())
    return ["DEFAULT_REFERENCE_AUTHORIZATION_EXPIRED"];
  if (latest.id !== captured.id || latest.revision !== captured.revision)
    return ["DEFAULT_REFERENCE_AUTHORIZATION_CHANGED"];
  if (
    captured.status !== "CLEARED" ||
    captured.commercialAiImageUseAttested !== true
  )
    return ["DEFAULT_REFERENCE_AUTHORIZATION_NOT_CLEARED"];
  return [];
}

function policyFingerprintChain(chain: AiEditorialContextChain) {
  return {
    ...chain,
    source: {
      ...chain.source,
      authorizationDecidedAt: chain.source.authorizationDecidedAt.toISOString(),
    },
    cut: {
      ...chain.cut,
      resultSizeBytes: chain.cut.resultSizeBytes.toString(),
    },
    reference: chain.reference
      ? {
          ...chain.reference,
          latestAuthorizationExpiresAt:
            chain.reference.latestAuthorizationExpiresAt?.toISOString() ?? null,
        }
      : null,
  };
}

function blockedResolution(
  capability: AiCapability,
  blocker: AiEditorialContextBlocker,
): AiEditorialContextResolution {
  return {
    capability,
    admitted: false,
    blockers: [blocker],
    contextPolicyFingerprint: null,
    chain: null,
  };
}

function olderThanCreated(cursor: { createdAt: Date; id: string }) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

function page<T, TRow>(
  items: T[],
  rows: TRow[],
  limit: number,
  scope: string,
  cursorOf: (row: TRow) => { createdAt: Date; id: string },
): Page<T> {
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    items,
    nextCursor: last ? encodeScopedCursor({ scope, ...cursorOf(last) }) : null,
  };
}

function mapAuthorization(row: CreatorReferenceAuthorizationRevision) {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    declarationVersion: row.declarationVersion,
    commercialAiImageUseAttested: row.commercialAiImageUseAttested,
    basis: row.basis,
    scope: row.scope,
    expiresAt: row.expiresAt,
    externalProviderTransferAllowed: row.externalProviderTransferAllowed,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new AiContentPersistenceConflictError();
  return value.map((item) => {
    if (typeof item !== "string") throw new AiContentPersistenceConflictError();
    return item;
  });
}

function unusable(blocker: string): LikenessUsability {
  return {
    usable: false,
    blocker,
    externalProviderTransferAllowed: false,
  };
}

function isImageType(
  value: string,
): value is "image/jpeg" | "image/png" | "image/webp" {
  return (
    value === "image/jpeg" || value === "image/png" || value === "image/webp"
  );
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "P2002" || error.code === "P2034")
  );
}
