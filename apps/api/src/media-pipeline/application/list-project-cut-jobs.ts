import { Inject, Injectable } from "@nestjs/common";

import {
  PIPELINE_REPOSITORY,
  type PipelineRepository,
} from "./pipeline-repository.port.js";

@Injectable()
export class ListProjectCutJobs {
  constructor(
    @Inject(PIPELINE_REPOSITORY)
    private readonly repository: PipelineRepository,
  ) {}

  async execute(projectId: string, limit = 50) {
    return this.repository.listProjectCutJobs(
      projectId,
      Math.min(100, Math.max(1, limit)),
    );
  }
}
