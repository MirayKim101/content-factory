import type { ProjectLibraryItem, ProjectView } from "../domain/project.js";
import type {
  ProjectLibraryItemDto,
  ProjectResponseDto,
} from "./project.dto.js";

export function toProjectResponse(project: ProjectView): ProjectResponseDto {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    rights: {
      confirmedAt: project.rightsConfirmedAt.toISOString(),
      declarationVersion: project.rightsDeclarationVersion,
    },
    ...(project.failure ? { failure: project.failure } : {}),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    source: {
      ...project.source,
      sizeBytes: project.source.sizeBytes.toString(),
    },
    artifact: {
      ...project.artifact,
      sizeBytes: project.artifact.sizeBytes.toString(),
    },
  };
}

export function toProjectLibraryItemResponse(
  project: ProjectLibraryItem,
): ProjectLibraryItemDto {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    source: {
      ...project.source,
      addedAt: project.source.addedAt.toISOString(),
      sizeBytes: project.source.sizeBytes.toString(),
    },
    cutJobCounts: project.cutJobCounts,
  };
}
