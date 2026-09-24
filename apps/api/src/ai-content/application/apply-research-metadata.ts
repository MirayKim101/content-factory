import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_AI_METADATA_APPLIER,
  type EditorialAiMetadataApplier,
} from "../../editorial-content/application/editorial-ai-metadata-applier.port.js";
import {
  RESEARCH_SUGGESTION_REPOSITORY,
  type ResearchSuggestionRepository,
} from "./research-suggestion-repository.port.js";

@Injectable()
export class ApplyResearchMetadata {
  constructor(
    @Inject(RESEARCH_SUGGESTION_REPOSITORY)
    private readonly repository: ResearchSuggestionRepository,
    @Inject(EDITORIAL_AI_METADATA_APPLIER)
    private readonly editorial: EditorialAiMetadataApplier,
  ) {}

  async execute(input: {
    researchIntentId: string;
    expectedEditorialRevision: number;
    idempotencyKey: string;
    title: string;
    description: string;
    tags: string[];
  }) {
    const context = await this.repository.resolveForApply(
      input.researchIntentId,
    );
    const title = input.title.trim();
    const description = input.description.trim();
    const tags = input.tags.map((tag) => tag.trim());
    const exact =
      title === context.suggestion.title &&
      description === context.suggestion.description &&
      tags.length === context.suggestion.tags.length &&
      tags.every((tag, index) => tag === context.suggestion.tags[index]);
    return this.editorial.apply({
      pipelineJobId: context.pipelineJobId,
      expectedRevision: input.expectedEditorialRevision,
      idempotencyKey: input.idempotencyKey,
      title,
      description,
      tags,
      provenance: {
        mode: exact ? "AI_ASSISTED" : "MIXED",
        basisVersion: context.suggestion.basisVersion,
        researchIntentId: context.researchIntentId,
        suggestionSetId: context.suggestionSetId,
      },
    });
  }
}
