import { Inject, Injectable } from "@nestjs/common";

import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from "./project-repository.port.js";

@Injectable()
export class SourceAuthorizationPolicy {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
  ) {}

  isCleared(
    sourceId: string,
    sourceVersion: number,
    sourceSha256: string,
  ): Promise<boolean> {
    return this.projects.isSourceAuthorized(
      sourceId,
      sourceVersion,
      sourceSha256,
    );
  }
}
