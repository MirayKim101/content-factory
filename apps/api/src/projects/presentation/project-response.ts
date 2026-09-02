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
    rights:
      project.rightsConfirmedAt && project.rightsDeclarationVersion
        ? {
            confirmedAt: project.rightsConfirmedAt.toISOString(),
            declarationVersion: project.rightsDeclarationVersion,
          }
        : null,
    ...(project.failure ? { failure: project.failure } : {}),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    source: {
      ...project.source,
      sizeBytes: project.source.sizeBytes.toString(),
      authorization: {
        sourceVersion: project.source.authorization.sourceVersion,
        status: project.source.authorization.status,
        ...(project.source.authorization.basis
          ? { basis: project.source.authorization.basis }
          : {}),
        ...(project.source.authorization.declarationVersion
          ? {
              declarationVersion:
                project.source.authorization.declarationVersion,
            }
          : {}),
        ...(project.source.authorization.decidedAt
          ? { decidedAt: project.source.authorization.decidedAt.toISOString() }
          : {}),
        revision: project.source.authorization.revision,
      },
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
      authorization: {
        sourceVersion: project.source.authorization.sourceVersion,
        status: project.source.authorization.status,
        ...(project.source.authorization.basis
          ? { basis: project.source.authorization.basis }
          : {}),
        ...(project.source.authorization.declarationVersion
          ? {
              declarationVersion:
                project.source.authorization.declarationVersion,
            }
          : {}),
        ...(project.source.authorization.decidedAt
          ? { decidedAt: project.source.authorization.decidedAt.toISOString() }
          : {}),
        revision: project.source.authorization.revision,
      },
    },
    cutJobCounts: project.cutJobCounts,
  };
}
