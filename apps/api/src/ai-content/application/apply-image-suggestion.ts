import { Inject, Injectable } from "@nestjs/common";

import { EDITORIAL_AI_THUMBNAIL_APPLIER, type EditorialAiThumbnailApplier } from "../../editorial-content/application/editorial-ai-thumbnail-applier.port.js";
import { IMAGE_SUGGESTION_REPOSITORY, type ImageSuggestionRepository } from "./image-suggestion-repository.port.js";

@Injectable()
export class ApplyImageSuggestion {
  constructor(
    @Inject(IMAGE_SUGGESTION_REPOSITORY) private readonly repository: ImageSuggestionRepository,
    @Inject(EDITORIAL_AI_THUMBNAIL_APPLIER) private readonly editorial: EditorialAiThumbnailApplier,
  ) {}

  async execute(input: { imageIntentId: string; expectedEditorialRevision: number; idempotencyKey: string }) {
    const stored = await this.repository.detail(input.imageIntentId);
    if (stored?.state === "READY" && stored.candidate) {
      const replay = await this.editorial.replay({
        pipelineJobId: stored.cutPipelineJobId,
        expectedRevision: input.expectedEditorialRevision,
        idempotencyKey: input.idempotencyKey,
        provenance: this.provenance(stored.id, stored.candidate),
      });
      if (replay) return replay;
    }
    const context = await this.repository.resolveForApply(input.imageIntentId);
    return this.editorial.apply({
      pipelineJobId: context.pipelineJobId,
      expectedRevision: input.expectedEditorialRevision,
      idempotencyKey: input.idempotencyKey,
      provenance: this.provenance(context.imageIntentId, context.candidate),
    });
  }

  private provenance(imageIntentId: string, candidate: { id: string; costBasisVersion: string; sha256: string }) {
    return {
      mode: "AI_ASSISTED" as const,
      basisVersion: `${candidate.costBasisVersion}:${candidate.sha256}`,
      imageIntentId,
      imageCandidateId: candidate.id,
    };
  }
}
