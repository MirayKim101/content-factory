import { Inject, Injectable, Logger } from "@nestjs/common";

import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from "./project-repository.port.js";
import { UploadError } from "./upload-errors.js";
import type { ProjectView } from "../domain/project.js";

export const CURRENT_SOURCE_RIGHTS_DECLARATION = "source-rights-v1";

export interface ConfirmSourceAuthorizationInput {
  projectId: string;
  sourceVersion: number;
  sourceSha256: string;
  declarationVersion: string;
  requestId: string;
}

@Injectable()
export class ConfirmSourceAuthorization {
  private readonly logger = new Logger(ConfirmSourceAuthorization.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
  ) {}

  async execute(input: ConfirmSourceAuthorizationInput): Promise<ProjectView> {
    const result = await this.projects.confirmSourceAuthorization(
      { ...input, confirmedAt: new Date() },
      CURRENT_SOURCE_RIGHTS_DECLARATION,
    );
    if (result.outcome === "CLEARED") {
      this.logger.log({
        event: "source_authorization_confirmed",
        projectId: result.project.id,
        sourceId: result.project.source.id,
        sourceVersion: result.project.source.sourceVersion,
        declarationVersion: result.project.authorization.declarationVersion,
        requestId: input.requestId,
        result: result.changed ? "CLEARED" : "IDEMPOTENT",
      });
      return result.project;
    }
    const statuses: Record<typeof result.outcome, number> = {
      PROJECT_NOT_FOUND: 404,
      SOURCE_NOT_READY: 409,
      SOURCE_VERSION_MISMATCH: 409,
      RIGHTS_DECLARATION_OUTDATED: 409,
      SOURCE_AUTHORIZATION_CONFLICT: 409,
    };
    this.logger.warn({
      event: "source_authorization_denied",
      projectId: input.projectId,
      sourceVersion: input.sourceVersion,
      declarationVersion: input.declarationVersion,
      requestId: input.requestId,
      result: result.outcome,
    });
    throw new UploadError(
      result.outcome,
      authorizationErrorMessage(result.outcome),
      statuses[result.outcome],
    );
  }
}

function authorizationErrorMessage(code: string): string {
  return {
    PROJECT_NOT_FOUND: "Project was not found.",
    SOURCE_NOT_READY: "The source is not ready for authorization.",
    SOURCE_VERSION_MISMATCH: "The source version or checksum is stale.",
    RIGHTS_DECLARATION_OUTDATED: "The rights declaration is outdated.",
    SOURCE_AUTHORIZATION_CONFLICT:
      "The source was already cleared with different confirmation data.",
  }[code]!;
}
