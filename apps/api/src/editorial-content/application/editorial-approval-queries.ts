import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_APPROVAL_REPOSITORY,
  type EditorialApprovalRepository,
} from "./editorial-approval-repository.port.js";

@Injectable()
export class GetEditorialReview {
  constructor(
    @Inject(EDITORIAL_APPROVAL_REPOSITORY)
    private readonly repository: EditorialApprovalRepository,
  ) {}

  execute(cutPipelineJobId: string) {
    return this.repository.getReview(cutPipelineJobId);
  }
}

@Injectable()
export class ListEditorialApprovals {
  constructor(
    @Inject(EDITORIAL_APPROVAL_REPOSITORY)
    private readonly repository: EditorialApprovalRepository,
  ) {}

  execute(input: { projectId: string; cursor?: string; limit: number }) {
    return this.repository.listProject(input);
  }
}
