export const EDITORIAL_EXPORT_CONTRACT = "editorial-export-zip-v1" as const;
export const EDITORIAL_EXPORT_PROGRESS_SCHEMA =
  "editorial-export-progress-v1" as const;

export type EditorialExportState =
  "QUEUED" | "PROCESSING" | "RETRY_WAIT" | "READY" | "FAILED_FINAL";

export type EditorialExportProgressPhase =
  "READ_INPUTS" | "WRITE_ARCHIVE" | "OUTPUT_HASH" | "UPLOAD" | "FINALIZE";

export interface EditorialExportManifestEntry {
  name: string;
  sizeBytes: string;
  sha256: string;
}

export interface EditorialExportView {
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  cutPipelineJobId: string;
  approvalId: string;
  approvalCandidateFingerprint: string;
  editorialPackageRevisionId: string;
  recipeRevisionId: string;
  assemblyRenderResultId: string;
  exportContractVersion: typeof EDITORIAL_EXPORT_CONTRACT;
  approvalCurrent: boolean;
  job: {
    id: string;
    revision: number;
    state: EditorialExportState;
    attempt: number;
    retryBudget: number;
    nextAttemptAt: Date | null;
    admissionReason: string | null;
    progress: {
      schemaVersion: typeof EDITORIAL_EXPORT_PROGRESS_SCHEMA;
      attemptNumber: number;
      phase: EditorialExportProgressPhase;
      basisPoints: number;
      updatedAt: Date;
    } | null;
    failure: { code: string; message: string; retryable: boolean } | null;
  };
  result: {
    filename: string;
    sizeBytes: bigint;
    sha256: string;
    manifest: unknown;
    completedAt: Date;
  } | null;
  createdAt: Date;
}

export class EditorialExportNotFoundError extends Error {}
export class EditorialExportCursorInvalidError extends Error {}
export class EditorialExportIdempotencyConflictError extends Error {}
export class EditorialExportApprovalStaleError extends Error {}
export class EditorialExportAuthorizationError extends Error {}
export class EditorialExportLineageInvalidError extends Error {}
export class EditorialExportResultNotReadyError extends Error {}
export class EditorialExportUnavailableError extends Error {}
