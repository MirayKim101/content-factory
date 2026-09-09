import type { ProjectListPage, ProjectListQuery } from "../domain/project.js";

export const PROJECT_LIBRARY_REPOSITORY = Symbol("PROJECT_LIBRARY_REPOSITORY");

export interface ProjectLibraryRepository {
  list(query: ProjectListQuery): Promise<ProjectListPage>;
}
