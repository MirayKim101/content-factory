import type {
  EditorialAssetView,
  EditorialPackageView,
  ProcessingTemplateRevisionView,
  ThumbnailContentType,
} from "../domain/editorial.js";

export const EDITORIAL_REPOSITORY = Symbol("EDITORIAL_REPOSITORY");

export interface EditorialRepository {
  createTemplate(input: {
    templateId: string;
    revisionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    name: string;
  }): Promise<ProcessingTemplateRevisionView>;
  listTemplates(): Promise<ProcessingTemplateRevisionView[]>;
  findAssetByIdempotencyKey(key: string): Promise<{
    asset: EditorialAssetView;
    requestFingerprint: string;
  } | null>;
  createPendingAsset(input: {
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
  }): Promise<void>;
  finalizeAsset(
    id: string,
    receipt: { etag?: string; version?: string },
  ): Promise<EditorialAssetView>;
  failAsset(id: string, code: string, message: string): Promise<void>;
  completeAssetCleanup(id: string): Promise<void>;
  recordAssetCleanupFailure(id: string, code: string): Promise<void>;
  getAssetFinalization(id: string): Promise<EditorialAssetView | null>;
  listRecoverableAssets(input: { staleBefore: Date; limit: number }): Promise<
    Array<{
      id: string;
      status: "PENDING" | "FAILED_FINAL";
      cleanupStatus: "NOT_REQUIRED" | "PENDING";
      objectKey: string;
      sizeBytes: bigint;
      sha256: string;
    }>
  >;
  listAssets(projectId: string): Promise<EditorialAssetView[]>;
  getAsset(
    projectId: string,
    assetId: string,
  ): Promise<{
    asset: EditorialAssetView;
    objectKey: string;
  } | null>;
  savePackage(input: {
    packageId: string;
    revisionId: string;
    mutationId: string;
    pipelineJobId: string;
    expectedRevision: number;
    idempotencyKey: string;
    requestFingerprint: string;
    processingTemplateRevisionId: string;
    title: string | null;
    description: string | null;
    tags: string[] | null;
    thumbnailAssetId: string | null;
  }): Promise<EditorialPackageView>;
  getPackage(pipelineJobId: string): Promise<EditorialPackageView | null>;
  listPackages(projectId: string): Promise<EditorialPackageView[]>;
}

export class EditorialIdempotencyConflictError extends Error {}
export class EditorialProjectNotFoundError extends Error {}
export class EditorialAssetNotFoundError extends Error {}
export class EditorialAssetProjectMismatchError extends Error {}
export class ProcessingTemplateRevisionNotFoundError extends Error {}
export class EditorialCutNotReadyError extends Error {}
export class EditorialCutArtifactInvalidError extends Error {}
export class EditorialRevisionConflictError extends Error {}
export class EditorialPersistenceConflictError extends Error {}
