import { Inject, Injectable } from "@nestjs/common";

import {
  AI_SOURCE_LINEAGE,
  type AiSourceLineagePort,
} from "../../projects/application/ai-source-lineage.port.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { AiCutLineagePort } from "../application/ai-cut-lineage.port.js";

@Injectable()
export class PrismaAiCutLineage implements AiCutLineagePort {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AI_SOURCE_LINEAGE)
    private readonly sourceLineage: AiSourceLineagePort,
  ) {}

  async resolveReadyCut(cutPipelineJobId: string) {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: cutPipelineJobId },
      include: { resultArtifact: true },
    });
    const artifact = job?.resultArtifact;
    if (
      !job ||
      job.type !== "CUT_SEGMENT" ||
      job.state !== "READY" ||
      !artifact ||
      artifact.status !== "READY" ||
      artifact.role !== "CUT_RESULT" ||
      artifact.projectId !== job.projectId ||
      artifact.sourceId !== job.sourceId ||
      artifact.lineageSourceId !== job.sourceId ||
      artifact.lineageSourceVersion !== job.sourceVersion ||
      artifact.pipelineJobId !== job.id ||
      artifact.sha256.length !== 64 ||
      artifact.sizeBytes <= 0n
    ) {
      return null;
    }
    const source = await this.sourceLineage.resolveAuthorizedSource(
      job.projectId,
      job.sourceId,
      job.sourceVersion,
    );
    return source
      ? {
          cutPipelineJobId: job.id,
          projectId: job.projectId,
          sourceId: job.sourceId,
          sourceVersion: job.sourceVersion,
          resultArtifactId: artifact.id,
          resultSha256: artifact.sha256,
          resultSizeBytes: artifact.sizeBytes,
          sourceSha256: source.sourceSha256,
          authorizationRevision: source.authorizationRevision,
          authorizationBasis: source.authorizationBasis,
          authorizationDeclarationVersion:
            source.authorizationDeclarationVersion,
          authorizationDecidedAt: source.authorizationDecidedAt,
        }
      : null;
  }
}
