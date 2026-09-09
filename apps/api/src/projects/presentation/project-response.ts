import { sourceAuthorizationRuntime } from "../../config/environment.js";
import type { ProjectLibraryItem, ProjectView } from "../domain/project.js";
import { isSourceAuthorizationCleared } from "../domain/source-authorization.js";
import type {
  ProjectLibraryItemDto,
  ProjectResponseDto,
} from "./project.dto.js";

export function toProjectResponse(project: ProjectView): ProjectResponseDto {
  const authorizationPolicy = sourceAuthorizationRuntime().policy;
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
        usable: isSourceAuthorizationCleared(
          project.source.authorization,
          project.source.sourceVersion,
          authorizationPolicy,
        ),
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
  const authorizationPolicy = sourceAuthorizationRuntime().policy;
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
        usable: isSourceAuthorizationCleared(
          project.source.authorization,
          project.source.sourceVersion,
          authorizationPolicy,
        ),
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
