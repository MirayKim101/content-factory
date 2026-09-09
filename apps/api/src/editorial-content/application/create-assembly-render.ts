import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  JOB_DISPATCH,
  type JobDispatch,
} from "../../media-pipeline/application/job-dispatch.port.js";
import {
  ASSEMBLY_RENDER_ADMISSION_ENABLED,
  ASSEMBLY_RENDER_REPOSITORY,
  type AssemblyRenderRepository,
} from "./assembly-render-repository.port.js";
import { AssemblyRenderUnavailableError } from "../domain/assembly-render.js";

@Injectable()
export class CreateAssemblyRender {
  constructor(
    @Inject(ASSEMBLY_RENDER_REPOSITORY)
    private readonly repository: AssemblyRenderRepository,
    @Inject(JOB_DISPATCH) private readonly dispatch: JobDispatch,
    @Inject(ASSEMBLY_RENDER_ADMISSION_ENABLED)
    private readonly admissionEnabled: boolean,
  ) {}

  async execute(input: {
    cutPipelineJobId: string;
    recipeRevision: number;
    idempotencyKey: string;
  }) {
    if (!this.admissionEnabled) throw new AssemblyRenderUnavailableError();
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          cutPipelineJobId: input.cutPipelineJobId,
          recipeRevision: input.recipeRevision,
        }),
      )
      .digest("hex");
    const created = await this.repository.create({
      intentId: randomUUID(),
      requestId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      ...input,
      requestFingerprint,
    });
    await Promise.allSettled([this.dispatch.dispatch(created.delivery)]);
    return created.view;
  }
}
