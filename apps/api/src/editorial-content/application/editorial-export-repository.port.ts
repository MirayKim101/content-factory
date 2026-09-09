import type { JobDelivery } from "../../media-pipeline/application/job-dispatch.port.js";
import type { EditorialExportView } from "../domain/editorial-export.js";

export const EDITORIAL_EXPORT_REPOSITORY = Symbol(
  "EDITORIAL_EXPORT_REPOSITORY",
);
export const EDITORIAL_EXPORT_ADMISSION_ENABLED = Symbol(
  "EDITORIAL_EXPORT_ADMISSION_ENABLED",
);

export interface EditorialExportRepository {
  create(input: {
    intentId: string;
    operationRequestId: string;
    jobId: string;
    attemptId: string;
    approvalId: string;
    idempotencyKey: string;
  }): Promise<{ view: EditorialExportView; delivery: JobDelivery }>;
  get(exportId: string): Promise<EditorialExportView | null>;
  listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<EditorialExportView[]>;
  getContent(exportId: string): Promise<{
    objectKey: string;
    sizeBytes: bigint;
    filename: string;
  } | null>;
}
