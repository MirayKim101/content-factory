import { Inject, Injectable } from "@nestjs/common";

import {
  PIPELINE_REPOSITORY,
  type PipelineRepository,
} from "./pipeline-repository.port.js";

@Injectable()
export class GetPipelineJob {
  constructor(
    @Inject(PIPELINE_REPOSITORY)
    private readonly repository: PipelineRepository,
  ) {}

  execute(id: string) {
    return this.repository.getJob(id);
  }
}
