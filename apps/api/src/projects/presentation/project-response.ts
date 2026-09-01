import type { ProjectView } from "../domain/project.js";
import type { ProjectResponseDto } from "./project.dto.js";

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
