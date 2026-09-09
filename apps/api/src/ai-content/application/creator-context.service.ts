import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rm } from "node:fs/promises";
import { basename } from "node:path";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { safeCause } from "../../projects/application/safe-cause.js";
import {
  CREATOR_RIGHTS_DECLARATION_VERSION,
  CreatorContextError,
  canonicalFingerprint,
  canonicalizeOfficialUrl,
  normalizeOrderedStrings,
  type AiCapability,
  type CreatorProfileEditableRevision,
  type CutPromptEditableRevision,
  type SourceContextEditableRevision,
} from "../domain/creator-context.js";
import {
  CREATOR_CONTEXT_REPOSITORY,
  type CreatorContextRepository,
  type CreatorReferenceAssetView,
  type DefaultReferenceMutationInput,
} from "./creator-context-repository.port.js";
import {
  CREATOR_CONTEXT_STORAGE,
  type CreatorContextStorage,
} from "./creator-context-storage.port.js";
import {
  REFERENCE_IMAGE_INSPECTOR,
  type ReferenceImageInspector,
} from "./reference-image-inspector.port.js";

export const CREATOR_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;

@Injectable()
export class CreatorContextService {
  private readonly logger = new Logger(CreatorContextService.name);

  constructor(
    @Inject(CREATOR_CONTEXT_REPOSITORY)
    private readonly repository: CreatorContextRepository,
    @Inject(CREATOR_CONTEXT_STORAGE)
    private readonly storage: CreatorContextStorage,
    @Inject(REFERENCE_IMAGE_INSPECTOR)
    private readonly imageInspector: ReferenceImageInspector,
  ) {}

  createProfile(input: {
    idempotencyKey: string;
    editableRevision: CreatorProfileEditableRevision;
  }) {
    const editableRevision = normalizeProfile(input.editableRevision);
    const canonicalOfficialUrl = canonicalizeOfficialUrl(
      editableRevision.officialUrl,
    );
    editableRevision.officialUrl = canonicalOfficialUrl;
    return this.repository.createProfile({
      profileId: randomUUID(),
      revisionId: randomUUID(),
      urlIdentityId: randomUUID(),
      operationId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: operationFingerprint("CREATE_CREATOR_PROFILE", {
        editableRevision,
        canonicalOfficialUrl,
      }),
      editableRevision,
      canonicalOfficialUrl,
    });
  }

  updateProfile(input: {
    profileId: string;
    expectedRevision: number;
    idempotencyKey: string;
    editableRevision: CreatorProfileEditableRevision;
  }) {
    const editableRevision = normalizeProfile(input.editableRevision);
    const canonicalOfficialUrl = canonicalizeOfficialUrl(
      editableRevision.officialUrl,
    );
    editableRevision.officialUrl = canonicalOfficialUrl;
    return this.repository.updateProfile({
      profileId: input.profileId,
      expectedRevision: input.expectedRevision,
      revisionId: randomUUID(),
      urlIdentityId: randomUUID(),
      operationId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: operationFingerprint("UPDATE_CREATOR_PROFILE", {
        profileId: input.profileId,
        expectedRevision: input.expectedRevision,
        editableRevision,
        canonicalOfficialUrl,
      }),
      editableRevision,
      canonicalOfficialUrl,
    });
  }

  async uploadReference(input: {
    creatorProfileId: string;
    idempotencyKey: string;
    originalFilename: string;
    declaredContentType: string;
    filePath: string;
  }) {
    try {
      await chmod(input.filePath, 0o600);
      const bytes = await readFile(input.filePath);
      if (bytes.length === 0 || bytes.length > CREATOR_REFERENCE_MAX_BYTES) {
        throw new CreatorContextError(
          "CREATOR_REFERENCE_SIZE_INVALID",
          `Reference image must be between 1 and ${CREATOR_REFERENCE_MAX_BYTES} bytes.`,
          413,
        );
      }
      const inspected = this.imageInspector.inspect(
        bytes,
        input.declaredContentType,
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const originalFilename = basename(
        input.originalFilename.replaceAll("\\", "/"),
      );
      const requestFingerprint = operationFingerprint(
        "UPLOAD_CREATOR_REFERENCE",
        {
          creatorProfileId: input.creatorProfileId,
          originalFilename,
          contentType: inspected.contentType,
          sizeBytes: bytes.length,
          sha256,
          width: inspected.width,
          height: inspected.height,
        },
      );
      const replay = await this.repository.findReferenceUploadReplay(
        input.idempotencyKey,
        requestFingerprint,
      );
      if (replay) return this.awaitReferenceCompletion(replay);

      const assetId = randomUUID();
      const objectKey = `ai-content/creator-profiles/${input.creatorProfileId}/references/${assetId}/original`;
      const claim = await this.repository.createPendingReference({
        operationId: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        assetId,
        authorizationRevisionId: randomUUID(),
        creatorProfileId: input.creatorProfileId,
        objectKey,
        originalFilename,
        contentType: inspected.contentType,
        sizeBytes: BigInt(bytes.length),
        sha256,
        width: inspected.width,
        height: inspected.height,
      });
      if (!claim.ownsUpload) return this.awaitReferenceCompletion(claim.asset);
      if (claim.asset.status === "READY") return claim.asset;

      let receipt: { etag?: string; version?: string };
      try {
        receipt = await this.storage.putFile({
          objectKey: claim.objectKey,
          filePath: input.filePath,
          contentType: inspected.contentType,
          sha256,
        });
      } catch (error) {
        await this.failAndCleanup(claim.asset.id, claim.objectKey, error);
        throw new CreatorContextError(
          "CREATOR_REFERENCE_STORAGE_FAILED",
          "Reference image storage failed.",
          503,
        );
      }
      try {
        return await this.repository.finalizeReference(claim.asset.id, receipt);
      } catch (error) {
        const authoritative = await this.repository.getReferenceFinalization(
          claim.asset.id,
        );
        if (authoritative?.status === "READY") return authoritative;
        await this.failAndCleanup(claim.asset.id, claim.objectKey, error);
        throw new CreatorContextError(
          "CREATOR_REFERENCE_FINALIZE_FAILED",
          "Reference image finalization failed.",
          503,
        );
      }
    } finally {
      await rm(input.filePath, { force: true });
    }
  }

  updateAuthorization(input: {
    creatorProfileId: string;
    assetId: string;
    expectedRevision: number;
    decision: "CLEARED" | "REVOKED";
    declarationVersion?: string | null;
    commercialAiImageUseAttested?: boolean;
    basis?: string | null;
    scope?: string | null;
    expiresAt?: string | null;
    externalProviderTransferAllowed?: boolean;
    idempotencyKey: string;
  }) {
    const normalized = normalizeAuthorization(input);
    return this.repository.updateAuthorization({
      operationId: randomUUID(),
      authorizationRevisionId: randomUUID(),
      creatorProfileId: input.creatorProfileId,
      assetId: input.assetId,
      expectedRevision: input.expectedRevision,
      decision: input.decision,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: operationFingerprint(
        "UPDATE_CREATOR_REFERENCE_AUTHORIZATION",
        {
          creatorProfileId: input.creatorProfileId,
          assetId: input.assetId,
          expectedRevision: input.expectedRevision,
          ...normalized,
        },
      ),
      ...normalized,
    });
  }

  setDefaultReference(input: {
    profileId: string;
    expectedProfileRevision: number;
    selection: DefaultReferenceMutationInput["selection"];
    idempotencyKey: string;
  }) {
    return this.repository.setDefaultReference({
      operationId: randomUUID(),
      revisionId: randomUUID(),
      profileId: input.profileId,
      expectedProfileRevision: input.expectedProfileRevision,
      selection: input.selection,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: operationFingerprint(
        "SET_DEFAULT_CREATOR_REFERENCE",
        input,
      ),
    });
  }

  putSourceContext(input: {
    projectId: string;
    sourceId: string;
    sourceVersion: number;
    expectedRevision: number;
    editableRevision: SourceContextEditableRevision;
    idempotencyKey: string;
  }) {
    const editableRevision = normalizeSourceContext(input.editableRevision);
    return this.repository.putSourceContext({
      operationId: randomUUID(),
      contextId: randomUUID(),
      revisionId: randomUUID(),
      projectId: input.projectId,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      expectedRevision: input.expectedRevision,
      editableRevision,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: operationFingerprint("PUT_SOURCE_EDITORIAL_CONTEXT", {
        projectId: input.projectId,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        expectedRevision: input.expectedRevision,
        editableRevision,
      }),
    });
  }

  putCutPrompt(input: {
    cutPipelineJobId: string;
    expectedRevision: number;
    editableRevision: CutPromptEditableRevision;
    idempotencyKey: string;
  }) {
    const editableRevision = normalizeCutPrompt(input.editableRevision);
    return this.repository.putCutPrompt({
      operationId: randomUUID(),
      promptId: randomUUID(),
      revisionId: randomUUID(),
      cutPipelineJobId: input.cutPipelineJobId,
      expectedRevision: input.expectedRevision,
      editableRevision,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: operationFingerprint("PUT_CUT_EDITORIAL_PROMPT", {
        cutPipelineJobId: input.cutPipelineJobId,
        expectedRevision: input.expectedRevision,
        editableRevision,
      }),
    });
  }

  resolveEditorialContext(cutPipelineJobId: string, capability: AiCapability) {
    return this.repository.resolveEditorialContext(
      cutPipelineJobId,
      capability,
    );
  }

  private async awaitReferenceCompletion(
    initial: CreatorReferenceAssetView,
  ): Promise<CreatorReferenceAssetView> {
    let current = initial;
    const deadline = Date.now() + 30_000;
    while (current.status === "PENDING" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current =
        (await this.repository.getReferenceFinalization(initial.id)) ?? current;
    }
    if (current.status === "READY") return current;
    if (current.status === "FAILED_FINAL")
      throw new CreatorContextError(
        "CREATOR_REFERENCE_STORAGE_FAILED",
        "The authoritative reference upload failed.",
        503,
      );
    throw new CreatorContextError(
      "CREATOR_REFERENCE_UPLOAD_IN_PROGRESS",
      "The authoritative reference upload is still in progress.",
      503,
    );
  }

  private async failAndCleanup(
    assetId: string,
    objectKey: string,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.repository.failReference(
        assetId,
        "CREATOR_REFERENCE_UPLOAD_FAILED",
      );
    } catch (error) {
      this.logger.error({
        event: "creator_reference_failure_persistence_failed",
        assetId,
        cause: safeCause(error),
      });
      return;
    }
    try {
      await this.storage.deleteObject(objectKey);
      await this.repository.completeReferenceCleanup(assetId);
    } catch (error) {
      await this.repository
        .recordReferenceCleanupFailure(assetId, "OBJECT_DELETE_FAILED")
        .catch(() => undefined);
      this.logger.error({
        event: "creator_reference_cleanup_failed",
        assetId,
        cause: safeCause(error),
      });
    }
    this.logger.error({
      event: "creator_reference_upload_failed",
      assetId,
      cause: safeCause(cause),
    });
  }
}

function operationFingerprint(operation: string, body: unknown): string {
  return canonicalFingerprint({
    contractVersion: "ai-content-operation-v1",
    operation,
    body,
  });
}

function normalizeProfile(
  input: CreatorProfileEditableRevision,
): CreatorProfileEditableRevision {
  return {
    canonicalDisplayName: requiredText(
      input.canonicalDisplayName,
      "canonicalDisplayName",
      200,
    ),
    officialUrl: input.officialUrl.trim(),
    primaryLanguage: requiredText(input.primaryLanguage, "primaryLanguage", 35),
    topics: normalizeOrderedStrings(input.topics, "topics", 30).map((value) =>
      boundedText(value, "topics", 100),
    ),
    editorialNotes: boundedText(
      input.editorialNotes.trim(),
      "editorialNotes",
      5000,
    ),
    restrictions: normalizeOrderedStrings(
      input.restrictions,
      "restrictions",
      30,
    ).map((value) => boundedText(value, "restrictions", 500)),
  };
}

function normalizeSourceContext(
  input: SourceContextEditableRevision,
): SourceContextEditableRevision {
  return {
    creatorProfileId: input.creatorProfileId,
    creatorProfileRevision: input.creatorProfileRevision,
    sourceTitle: requiredText(input.sourceTitle, "sourceTitle", 500),
    gameOrTopic: requiredText(input.gameOrTopic, "gameOrTopic", 300),
    audience: requiredText(input.audience, "audience", 1000),
    editorialGoal: requiredText(input.editorialGoal, "editorialGoal", 1000),
    language: requiredText(input.language, "language", 35),
    defaultCta: boundedText(input.defaultCta.trim(), "defaultCta", 1000),
    restrictions: normalizeOrderedStrings(
      input.restrictions,
      "restrictions",
      30,
    ).map((value) => boundedText(value, "restrictions", 500)),
    operatorNotes: boundedText(
      input.operatorNotes.trim(),
      "operatorNotes",
      5000,
    ),
  };
}

function normalizeCutPrompt(
  input: CutPromptEditableRevision,
): CutPromptEditableRevision {
  return {
    sourceContextId: input.sourceContextId,
    sourceContextRevision: input.sourceContextRevision,
    whatHappens: requiredText(input.whatHappens, "whatHappens", 5000),
    desiredAngle: requiredText(input.desiredAngle, "desiredAngle", 1000),
    tone: requiredText(input.tone, "tone", 500),
    cta: boundedText(input.cta.trim(), "cta", 1000),
    restrictions: normalizeOrderedStrings(
      input.restrictions,
      "restrictions",
      30,
    ).map((value) => boundedText(value, "restrictions", 500)),
  };
}

function normalizeAuthorization(input: {
  decision: "CLEARED" | "REVOKED";
  declarationVersion?: string | null;
  commercialAiImageUseAttested?: boolean;
  basis?: string | null;
  scope?: string | null;
  expiresAt?: string | null;
  externalProviderTransferAllowed?: boolean;
}) {
  if (input.decision === "REVOKED") {
    return {
      declarationVersion: null,
      commercialAiImageUseAttested: false,
      basis: null,
      scope: null,
      expiresAt: null,
      externalProviderTransferAllowed: false,
    };
  }
  const basis = requiredText(input.basis ?? "", "basis", 1000);
  const scope = requiredText(input.scope ?? "", "scope", 1000);
  if (
    input.declarationVersion !== CREATOR_RIGHTS_DECLARATION_VERSION ||
    input.commercialAiImageUseAttested !== true
  ) {
    throw new CreatorContextError(
      "CREATOR_REFERENCE_ATTESTATION_INVALID",
      "Explicit commercial AI-image use attestation is required.",
      422,
    );
  }
  let expiresAt: Date | null = null;
  if (input.expiresAt) {
    expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new CreatorContextError(
        "CREATOR_REFERENCE_EXPIRY_INVALID",
        "Authorization expiry must be a future date-time.",
        422,
      );
    }
  }
  return {
    declarationVersion: CREATOR_RIGHTS_DECLARATION_VERSION,
    commercialAiImageUseAttested: true,
    basis,
    scope,
    expiresAt,
    externalProviderTransferAllowed:
      input.externalProviderTransferAllowed === true,
  };
}

function requiredText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CreatorContextError(
      "AI_CONTEXT_VALUE_INVALID",
      `${field} is required.`,
      422,
    );
  }
  return boundedText(normalized, field, maximum);
}

function boundedText(value: string, field: string, maximum: number): string {
  if (value.length > maximum) {
    throw new CreatorContextError(
      "AI_CONTEXT_VALUE_INVALID",
      `${field} exceeds ${maximum} characters.`,
      422,
    );
  }
  return value;
}
