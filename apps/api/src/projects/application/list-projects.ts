import { Inject, Injectable } from "@nestjs/common";

import type { ProjectListPage, ProjectListQuery } from "../domain/project.js";
import {
  PROJECT_LIBRARY_REPOSITORY,
  type ProjectLibraryRepository,
} from "./project-library-repository.port.js";

@Injectable()
export class ListProjects {
  constructor(
    @Inject(PROJECT_LIBRARY_REPOSITORY)
    private readonly projects: ProjectLibraryRepository,
  ) {}

  execute(query: ProjectListQuery): Promise<ProjectListPage> {
    return this.projects.list(query);
  }
}
