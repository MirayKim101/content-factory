import type {
  EditorialApprovalView,
  EditorialReviewView,
} from "../domain/editorial-approval.js";

export const EDITORIAL_APPROVAL_REPOSITORY = Symbol(
  "EDITORIAL_APPROVAL_REPOSITORY",
);
export const EDITORIAL_APPROVAL_ADMISSION_ENABLED = Symbol(
  "EDITORIAL_APPROVAL_ADMISSION_ENABLED",
);

export interface EditorialApprovalRepository {
  getReview(cutPipelineJobId: string): Promise<EditorialReviewView | null>;
  create(input: {
    approvalId: string;
    operationRequestId: string;
    renderId: string;
    editorialRevision: number;
    candidateFingerprint: string;
    manualAttentionMs: number;
    attentionMeasurementVersion: "foreground-preview-v1";
    idempotencyKey: string;
  }): Promise<EditorialApprovalView>;
  listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<EditorialApprovalView[]>;
}
