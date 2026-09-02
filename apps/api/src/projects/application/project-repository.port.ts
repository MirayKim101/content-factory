import type {
  PendingCleanup,
  PendingUpload,
  ProjectView,
} from "../domain/project.js";

export const PROJECT_REPOSITORY = Symbol("PROJECT_REPOSITORY");

export interface CreatePendingUploadRecord {
  projectId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  sourceId: string;
  artifactId: string;
  name: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: bigint;
  sha256: string;
  sourceVersion: number;
  objectKey: string;
  recipeVersion: string;
}

export interface StorageReceipt {
  etag?: string;
  version?: string;
}

export interface ProjectRepository {
  createPendingUpload(record: CreatePendingUploadRecord): Promise<void>;
  finalizeReady(artifactId: string, receipt: StorageReceipt): Promise<void>;
  markFailed(
    projectId: string,
    code: string,
    message: string,
    cleanupRequired: boolean,
  ): Promise<void>;
  requestCleanup(artifactId: string): Promise<void>;
  findByIdempotencyKey(
    key: string,
  ): Promise<{ project: ProjectView; requestFingerprint: string } | null>;
  getById(projectId: string): Promise<ProjectView | null>;
  findStalePending(before: Date, limit: number): Promise<PendingUpload[]>;
  findPendingCleanup(limit: number): Promise<PendingCleanup[]>;
  markCleanupCompleted(artifactId: string): Promise<void>;
  recordCleanupFailure(artifactId: string, errorCode: string): Promise<void>;
  attestSourceAuthorization(input: {
    projectId: string;
    sourceVersion: number;
    expectedRevision: number;
    declarationVersion: string;
  }): Promise<ProjectView>;
}

export class IdempotencyKeyAlreadyExistsError extends Error {}

export class TerminalStateConflictError extends Error {}
export class SourceVersionConflictError extends Error {}
export class SourceAuthorizationConflictError extends Error {}
export class SourceNotReadyForAuthorizationError extends Error {}
