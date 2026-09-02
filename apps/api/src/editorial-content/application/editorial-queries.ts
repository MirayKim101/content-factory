import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_REPOSITORY,
  type EditorialRepository,
} from "./editorial-repository.port.js";

@Injectable()
export class ListEditorialAssets {
  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
  ) {}
  execute(projectId: string) {
    return this.repository.listAssets(projectId);
  }
}

@Injectable()
export class GetEditorialAsset {
  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
  ) {}
  execute(projectId: string, assetId: string) {
    return this.repository.getAsset(projectId, assetId);
  }
}

@Injectable()
export class GetEditorialPackage {
  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
  ) {}
  execute(pipelineJobId: string) {
    return this.repository.getPackage(pipelineJobId);
  }
}

@Injectable()
export class ListEditorialPackages {
  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
  ) {}
  execute(projectId: string) {
    return this.repository.listPackages(projectId);
  }
}
