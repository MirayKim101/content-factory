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
export const EDITORIAL_INTEGRATED_REVIEW_ENABLED = Symbol(
  "EDITORIAL_INTEGRATED_REVIEW_ENABLED",
);

export interface EditorialApprovalRepository {
  getReview(cutPipelineJobId: string): Promise<EditorialReviewView | null>;
  create(input: {
    approvalId: string;
    operationRequestId: string;
    renderId: string;
    editorialRevision: number;
    candidateFingerprint: string;
    approvalContractVersion:
      "manual-horizontal-approval-v1" | "human-horizontal-approval-v2";
    manualAttentionMs?: number;
    attentionMeasurementVersion?: "foreground-preview-v1";
    attention?: {
      schemaVersion: "operator-attention-v2";
      preparationForegroundMs: number;
      finalReviewForegroundMs: number;
    };
    idempotencyKey: string;
  }): Promise<EditorialApprovalView>;
  listProject(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }): Promise<EditorialApprovalView[]>;
}
