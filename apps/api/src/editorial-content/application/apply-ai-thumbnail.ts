import { Inject, Injectable } from "@nestjs/common";

import { EDITORIAL_REPOSITORY, EditorialRevisionConflictError, type EditorialRepository } from "./editorial-repository.port.js";
import type { EditorialAiThumbnailApplier } from "./editorial-ai-thumbnail-applier.port.js";
import { SaveEditorialPackage } from "./save-editorial-package.js";

@Injectable()
export class ApplyAiThumbnail implements EditorialAiThumbnailApplier {
  constructor(@Inject(EDITORIAL_REPOSITORY) private readonly repository: EditorialRepository, private readonly savePackage: SaveEditorialPackage) {}

  async replay(input: Parameters<EditorialAiThumbnailApplier["apply"]>[0]) {
    const replay = await this.repository.getMutationResult(input.idempotencyKey);
    if (!replay) return null;
    return this.savePackage.execute({
      pipelineJobId: input.pipelineJobId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      processingTemplateRevisionId: replay.revision.processingTemplateRevision.id,
      title: replay.revision.title,
      description: replay.revision.description,
      tags: replay.revision.tags,
      thumbnailAssetId: null,
      metadataProvenance:
        replay.revision.provenance.metadata.mode === "MANUAL"
          ? undefined
          : {
              mode: replay.revision.provenance.metadata.mode,
              basisVersion: replay.revision.provenance.metadata.basisVersion,
              researchIntentId: this.requireMetadataIdentity(replay.revision.provenance.metadata.researchIntentId),
              suggestionSetId: this.requireMetadataIdentity(replay.revision.provenance.metadata.suggestionSetId),
            },
      thumbnailProvenance: input.provenance,
    });
  }

  async apply(input: { pipelineJobId: string; expectedRevision: number; idempotencyKey: string; provenance: { mode: "AI_ASSISTED"; basisVersion: string; imageIntentId: string; imageCandidateId: string } }) {
    const replay = await this.repository.getMutationResult(input.idempotencyKey);
    const current = replay ?? (await this.repository.getPackage(input.pipelineJobId));
    if (!current || (!replay && current.revision.revision !== input.expectedRevision)) throw new EditorialRevisionConflictError();
    return this.savePackage.execute({
      pipelineJobId: input.pipelineJobId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      processingTemplateRevisionId: current.revision.processingTemplateRevision.id,
      title: current.revision.title,
      description: current.revision.description,
      tags: current.revision.tags,
      thumbnailAssetId: null,
      metadataProvenance:
        current.revision.provenance.metadata.mode === "MANUAL"
          ? undefined
          : {
              mode: current.revision.provenance.metadata.mode,
              basisVersion: current.revision.provenance.metadata.basisVersion,
              researchIntentId: this.requireMetadataIdentity(current.revision.provenance.metadata.researchIntentId),
              suggestionSetId: this.requireMetadataIdentity(current.revision.provenance.metadata.suggestionSetId),
            },
      thumbnailProvenance: input.provenance,
    });
  }

  private requireMetadataIdentity(value: string | undefined): string {
    if (!value) throw new EditorialRevisionConflictError();
    return value;
  }
}
