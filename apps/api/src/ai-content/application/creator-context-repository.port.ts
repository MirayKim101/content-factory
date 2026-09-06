import type {
  AiCapability,
  CreatorProfileEditableRevision,
  CutPromptEditableRevision,
  SourceContextEditableRevision,
} from "../domain/creator-context.js";
import type { AiEditorialContextResolution } from "./resolve-ai-editorial-context.port.js";

export const CREATOR_CONTEXT_REPOSITORY = Symbol("CREATOR_CONTEXT_REPOSITORY");
export const AI_CONTEXT_ADMISSION_ENABLED = Symbol(
  "AI_CONTEXT_ADMISSION_ENABLED",
);

export type LikenessUsability = {
  usable: boolean;
  blocker: string | null;
  externalProviderTransferAllowed: boolean;
};

export type DefaultReferenceSnapshot = {
  assetId: string;
  authorizationRevisionId: string;
  authorizationRevision: number;
  authorizationStatus: "CLEARED" | "REVOKED" | "NOT_REVIEWED";
  expiresAt: Date | null;
  externalProviderTransferAllowed: boolean;
};

export type CreatorProfileRevisionView = {
  id: string;
  profileId: string;
  revision: number;
  editableRevision: CreatorProfileEditableRevision;
  officialUrlIdentity: {
    id: string;
    canonicalizationVersion: string;
    canonicalUrl: string;
  };
  likenessPolicy: "NO_REALISTIC_LIKENESS" | "CLEARED_REFERENCE_ONLY";
  defaultReference: DefaultReferenceSnapshot | null;
  status: "CURRENT" | "STALE";
  likenessUsability: LikenessUsability;
  createdAt: Date;
};

export type CreatorProfileDetail = {
  id: string;
  currentRevision: number;
  revision: CreatorProfileRevisionView;
  createdAt: Date;
  updatedAt: Date;
};

export type CreatorProfileSummary = {
  id: string;
  currentRevision: number;
  canonicalDisplayName: string;
  officialUrl: string;
  primaryLanguage: string;
  topics: string[];
  likenessPolicy: "NO_REALISTIC_LIKENESS" | "CLEARED_REFERENCE_ONLY";
  likenessAllowed: boolean;
  updatedAt: Date;
};

export type CreatorReferenceAssetView = {
  id: string;
  creatorProfileId: string;
  status: "PENDING" | "READY" | "FAILED_FINAL";
  originalFilename: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: bigint;
  sha256: string;
  width: number;
  height: number;
  currentAuthorization: CreatorReferenceAuthorizationView;
  createdAt: Date;
  updatedAt: Date;
};

export type CreatorReferenceUploadClaim = {
  asset: CreatorReferenceAssetView;
  objectKey: string;
  ownsUpload: boolean;
};

export type CreatorReferenceAuthorizationView = {
  id: string;
  revision: number;
  status: "NOT_REVIEWED" | "CLEARED" | "REVOKED";
  declarationVersion: string | null;
  commercialAiImageUseAttested: boolean;
  basis: string | null;
  scope: string | null;
  expiresAt: Date | null;
  externalProviderTransferAllowed: boolean;
  decidedAt: Date | null;
  createdAt: Date;
};

export type AuthorizationDetail = {
  assetId: string;
  creatorProfileId: string;
  currentRevision: number;
  current: CreatorReferenceAuthorizationView;
  history: CreatorReferenceAuthorizationView[];
};

export type SourceContextRevisionView = {
  id: string;
  contextId: string;
  revision: number;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  editableRevision: SourceContextEditableRevision;
  creatorProfileRevisionId: string;
  status: "CURRENT" | "STALE";
  blockers: string[];
  likenessUsability: LikenessUsability;
  createdAt: Date;
};

export type SourceContextDetail = {
  id: string;
  currentRevision: number;
  revision: SourceContextRevisionView;
  createdAt: Date;
  updatedAt: Date;
};

export type CutPromptRevisionView = {
  id: string;
  promptId: string;
  revision: number;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  cutPipelineJobId: string;
  cutResultArtifact: { id: string; sha256: string; sizeBytes: bigint };
  editableRevision: CutPromptEditableRevision;
  sourceContextRevisionId: string;
  status: "CURRENT" | "STALE";
  blockers: string[];
  likenessUsability: LikenessUsability;
  contextPolicyFingerprint: string;
  createdAt: Date;
};

export type CutPromptDetail = {
  id: string;
  currentRevision: number;
  revision: CutPromptRevisionView;
  createdAt: Date;
  updatedAt: Date;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export interface CreatorContextRepository {
  createProfile(
    input: ProfileMutationInput & {
      profileId: string;
      revisionId: string;
      urlIdentityId: string;
    },
  ): Promise<CreatorProfileDetail>;
  updateProfile(
    input: ProfileMutationInput & {
      profileId: string;
      expectedRevision: number;
      revisionId: string;
      urlIdentityId: string;
    },
  ): Promise<CreatorProfileDetail>;
  getProfile(
    profileId: string,
    revision?: number,
  ): Promise<CreatorProfileDetail | null>;
  listProfiles(input: PageInput): Promise<Page<CreatorProfileSummary>>;
  listProfileRevisions(
    profileId: string,
    input: PageInput,
  ): Promise<Page<CreatorProfileRevisionView>>;
  createPendingReference(
    input: ReferenceUploadRecord,
  ): Promise<CreatorReferenceUploadClaim>;
  findReferenceUploadReplay(
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<CreatorReferenceAssetView | null>;
  finalizeReference(
    assetId: string,
    receipt: { etag?: string; version?: string },
  ): Promise<CreatorReferenceAssetView>;
  failReference(assetId: string, code: string): Promise<void>;
  completeReferenceCleanup(assetId: string): Promise<void>;
  recordReferenceCleanupFailure(assetId: string, code: string): Promise<void>;
  listRecoverableReferences(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<
    Array<{
      id: string;
      status: "PENDING" | "FAILED_FINAL";
      cleanupStatus: "NOT_REQUIRED" | "PENDING";
      objectKey: string;
      sizeBytes: bigint;
      sha256: string;
    }>
  >;
  getReferenceFinalization(
    assetId: string,
  ): Promise<CreatorReferenceAssetView | null>;
  getReference(
    profileId: string,
    assetId: string,
  ): Promise<{ asset: CreatorReferenceAssetView; objectKey: string } | null>;
  listReferences(
    profileId: string,
    input: PageInput,
  ): Promise<Page<CreatorReferenceAssetView>>;
  updateAuthorization(
    input: AuthorizationMutationInput,
  ): Promise<AuthorizationDetail>;
  getAuthorization(
    profileId: string,
    assetId: string,
  ): Promise<AuthorizationDetail | null>;
  setDefaultReference(
    input: DefaultReferenceMutationInput,
  ): Promise<CreatorProfileDetail>;
  putSourceContext(
    input: SourceContextMutationInput,
  ): Promise<SourceContextDetail>;
  getSourceContext(
    projectId: string,
    sourceId: string,
    sourceVersion: number,
    revision?: number,
  ): Promise<SourceContextDetail | null>;
  listSourceContextRevisions(
    projectId: string,
    sourceId: string,
    sourceVersion: number,
    input: PageInput,
  ): Promise<Page<SourceContextRevisionView>>;
  putCutPrompt(input: CutPromptMutationInput): Promise<CutPromptDetail>;
  getCutPrompt(
    cutPipelineJobId: string,
    revision?: number,
  ): Promise<CutPromptDetail | null>;
  listCutPromptRevisions(
    cutPipelineJobId: string,
    input: PageInput,
  ): Promise<Page<CutPromptRevisionView>>;
  resolveEditorialContext(
    cutPipelineJobId: string,
    capability: AiCapability,
  ): Promise<AiEditorialContextResolution>;
}

export type PageInput = {
  cursor?: { createdAt: Date; id: string };
  limit: number;
  scope: string;
};

export type OperationIdentity = {
  operationId: string;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type ProfileMutationInput = OperationIdentity & {
  editableRevision: CreatorProfileEditableRevision;
  canonicalOfficialUrl: string;
};

export type ReferenceUploadRecord = OperationIdentity & {
  assetId: string;
  authorizationRevisionId: string;
  creatorProfileId: string;
  objectKey: string;
  originalFilename: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: bigint;
  sha256: string;
  width: number;
  height: number;
};

export type AuthorizationMutationInput = OperationIdentity & {
  authorizationRevisionId: string;
  creatorProfileId: string;
  assetId: string;
  expectedRevision: number;
  decision: "CLEARED" | "REVOKED";
  declarationVersion: string | null;
  commercialAiImageUseAttested: boolean;
  basis: string | null;
  scope: string | null;
  expiresAt: Date | null;
  externalProviderTransferAllowed: boolean;
};

export type DefaultReferenceMutationInput = OperationIdentity & {
  profileId: string;
  expectedProfileRevision: number;
  revisionId: string;
  selection:
    | { action: "CLEAR" }
    | {
        action: "SET";
        assetId: string;
        authorizationRevisionId: string;
        authorizationRevision: number;
      };
};

export type SourceContextMutationInput = OperationIdentity & {
  contextId: string;
  revisionId: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  expectedRevision: number;
  editableRevision: SourceContextEditableRevision;
};

export type CutPromptMutationInput = OperationIdentity & {
  promptId: string;
  revisionId: string;
  cutPipelineJobId: string;
  expectedRevision: number;
  editableRevision: CutPromptEditableRevision;
};

export class AiContentIdempotencyConflictError extends Error {}
export class CreatorProfileNotFoundError extends Error {}
export class CreatorProfileUrlConflictError extends Error {
  constructor(readonly existingProfileId: string) {
    super("CREATOR_PROFILE_OFFICIAL_URL_CONFLICT");
  }
}
export class AiContentRevisionConflictError extends Error {}
export class CreatorReferenceNotFoundError extends Error {}
export class CreatorReferenceSelectionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class SourceContextLineageError extends Error {}
export class CutPromptLineageError extends Error {}
export class AiContentPersistenceConflictError extends Error {}
