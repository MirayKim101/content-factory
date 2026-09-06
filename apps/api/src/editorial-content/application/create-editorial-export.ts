import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  JOB_DISPATCH,
  type JobDispatch,
} from "../../media-pipeline/application/job-dispatch.port.js";
import {
  EDITORIAL_EXPORT_ADMISSION_ENABLED,
  EDITORIAL_EXPORT_REPOSITORY,
  type EditorialExportRepository,
} from "./editorial-export-repository.port.js";
import { EditorialExportUnavailableError } from "../domain/editorial-export.js";

@Injectable()
export class CreateEditorialExport {
  constructor(
    @Inject(EDITORIAL_EXPORT_REPOSITORY)
    private readonly repository: EditorialExportRepository,
    @Inject(JOB_DISPATCH) private readonly dispatch: JobDispatch,
    @Inject(EDITORIAL_EXPORT_ADMISSION_ENABLED)
    private readonly admissionEnabled: boolean,
  ) {}

  async execute(input: { approvalId: string; idempotencyKey: string }) {
    if (!this.admissionEnabled) throw new EditorialExportUnavailableError();
    const created = await this.repository.create({
      intentId: randomUUID(),
      operationRequestId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      ...input,
    });
    await Promise.allSettled([this.dispatch.dispatch(created.delivery)]);
    return created.view;
  }
}
