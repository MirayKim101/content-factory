import { Inject, Injectable } from "@nestjs/common";

import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from "./project-repository.port.js";
import type { ProjectView } from "../domain/project.js";

@Injectable()
export class GetProject {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
  ) {}

  execute(id: string): Promise<ProjectView | null> {
    return this.projects.getById(id);
  }
}
