import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { CutSegmentIntent } from "../domain/pipeline-job.js";
import { JOB_DISPATCH, type JobDispatch } from "./job-dispatch.port.js";
import {
  PIPELINE_REPOSITORY,
  type PipelineRepository,
} from "./pipeline-repository.port.js";

@Injectable()
export class CreateCuts {
  constructor(
    @Inject(PIPELINE_REPOSITORY)
    private readonly repository: PipelineRepository,
    @Inject(JOB_DISPATCH) private readonly dispatch: JobDispatch,
  ) {}

  async execute(input: {
    projectId: string;
    idempotencyKey: string;
    segments: CutSegmentIntent[];
  }) {
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const created = await this.repository.createCuts({
      requestId: randomUUID(),
      ...input,
      requestFingerprint,
    });
    const deliveries = await this.repository.getRunnableJobsByIds(
      created.result.jobs.map((job) => job.id),
    );
    await Promise.allSettled(
      deliveries.map((delivery) => this.dispatch.dispatch(delivery)),
    );
    return created.result;
  }
}
