import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_APPROVAL_ADMISSION_ENABLED,
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
  ) {}

  execute(input: {
    renderId: string;
    editorialRevision: number;
    candidateFingerprint: string;
    manualAttentionMs: number;
    attentionMeasurementVersion: "foreground-preview-v1";
    idempotencyKey: string;
  }) {
    if (!this.admissionEnabled) throw new EditorialApprovalUnavailableError();
    return this.repository.create({
      approvalId: randomUUID(),
      operationRequestId: randomUUID(),
      ...input,
    });
  }
}
