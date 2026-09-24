import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_REPOSITORY,
  EditorialRevisionConflictError,
  type EditorialRepository,
} from "./editorial-repository.port.js";
import type { EditorialAiMetadataApplier } from "./editorial-ai-metadata-applier.port.js";
import { SaveEditorialPackage } from "./save-editorial-package.js";

@Injectable()
export class ApplyAiMetadata implements EditorialAiMetadataApplier {
  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
    private readonly savePackage: SaveEditorialPackage,
  ) {}

  async apply(input: {
    pipelineJobId: string;
    expectedRevision: number;
    idempotencyKey: string;
    title: string;
    description: string;
    tags: string[];
    provenance: {
      mode: "AI_ASSISTED" | "MIXED";
      basisVersion: string;
      researchIntentId: string;
      suggestionSetId: string;
    };
  }) {
    const replay = await this.repository.getMutationResult(
      input.idempotencyKey,
    );
    if (replay) {
      return this.savePackage.execute({
        pipelineJobId: input.pipelineJobId,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        processingTemplateRevisionId:
          replay.revision.processingTemplateRevision.id,
        title: input.title,
        description: input.description,
        tags: input.tags,
        thumbnailAssetId: replay.revision.thumbnail?.id ?? null,
        metadataProvenance: input.provenance,
        thumbnailProvenance: replay.revision.provenance.thumbnail,
      });
    }
    const current = await this.repository.getPackage(input.pipelineJobId);
    if (!current || current.revision.revision !== input.expectedRevision)
      throw new EditorialRevisionConflictError();
    return this.savePackage.execute({
      pipelineJobId: input.pipelineJobId,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      processingTemplateRevisionId:
        current.revision.processingTemplateRevision.id,
      title: input.title,
      description: input.description,
      tags: input.tags,
      thumbnailAssetId: current.revision.thumbnail?.id ?? null,
      metadataProvenance: input.provenance,
      thumbnailProvenance: current.revision.provenance.thumbnail,
    });
  }
}
