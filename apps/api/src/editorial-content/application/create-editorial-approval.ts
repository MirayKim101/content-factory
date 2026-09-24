import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_APPROVAL_ADMISSION_ENABLED,
  EDITORIAL_INTEGRATED_REVIEW_ENABLED,
  EDITORIAL_APPROVAL_REPOSITORY,
  type EditorialApprovalRepository,
} from "./editorial-approval-repository.port.js";
import { EditorialApprovalUnavailableError } from "../domain/editorial-approval.js";

@Injectable()
export class CreateEditorialApproval {
  constructor(
    @Inject(EDITORIAL_APPROVAL_REPOSITORY)
    private readonly repository: EditorialApprovalRepository,
    @Inject(EDITORIAL_APPROVAL_ADMISSION_ENABLED)
    private readonly admissionEnabled: boolean,
    @Inject(EDITORIAL_INTEGRATED_REVIEW_ENABLED)
    private readonly integratedReviewEnabled: boolean = false,
  ) {}

  execute(input: {
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
  }) {
    if (!this.admissionEnabled) throw new EditorialApprovalUnavailableError();
    if (
      input.approvalContractVersion === "human-horizontal-approval-v2" &&
      !this.integratedReviewEnabled
    )
      throw new EditorialApprovalUnavailableError();
    return this.repository.create({
      approvalId: randomUUID(),
      operationRequestId: randomUUID(),
      ...input,
    });
  }
}
