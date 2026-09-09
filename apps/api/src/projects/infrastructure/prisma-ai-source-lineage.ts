import { Inject, Injectable } from "@nestjs/common";

import { sourceAuthorizationRuntime } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import { isSourceAuthorizationCleared } from "../domain/source-authorization.js";
import type { AiSourceLineagePort } from "../application/ai-source-lineage.port.js";

@Injectable()
export class PrismaAiSourceLineage implements AiSourceLineagePort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolveAuthorizedSource(
    projectId: string,
    sourceId: string,
    sourceVersion: number,
  ) {
    const source = await this.prisma.videoSource.findFirst({
      where: { id: sourceId, projectId, sourceVersion, status: "READY" },
      include: { authorizations: true },
    });
    if (!source) return null;
    const authorization = source.authorizations.find(
      (candidate) => candidate.sourceVersion === sourceVersion,
    );
    const usable = isSourceAuthorizationCleared(
      authorization
        ? {
            sourceVersion: authorization.sourceVersion,
            status: authorization.status,
            revision: authorization.revision,
            ...(authorization.basis ? { basis: authorization.basis } : {}),
            ...(authorization.declarationVersion
              ? { declarationVersion: authorization.declarationVersion }
              : {}),
            ...(authorization.decidedAt
              ? { decidedAt: authorization.decidedAt }
              : {}),
          }
        : null,
      sourceVersion,
      sourceAuthorizationRuntime().policy,
    );
    return usable
      ? {
          projectId,
          sourceId,
          sourceVersion,
          sourceSha256: source.sha256,
          authorizationRevision: authorization!.revision,
          authorizationBasis: authorization!.basis!,
          authorizationDeclarationVersion: authorization!.declarationVersion!,
          authorizationDecidedAt: authorization!.decidedAt!,
        }
      : null;
  }
}
