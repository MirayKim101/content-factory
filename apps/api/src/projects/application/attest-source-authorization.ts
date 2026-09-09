import { Inject, Injectable } from "@nestjs/common";

import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from "./project-repository.port.js";

@Injectable()
export class AttestSourceAuthorization {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
  ) {}

  execute(input: {
    projectId: string;
    sourceVersion: number;
    expectedRevision: number;
    declarationVersion: "source-authorization-v1";
  }) {
    return this.projects.attestSourceAuthorization(input);
  }
}
