import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  EDITORIAL_REPOSITORY,
  type EditorialRepository,
} from "./editorial-repository.port.js";

@Injectable()
export class SaveEditorialPackage {
  constructor(
    @Inject(EDITORIAL_REPOSITORY)
    private readonly repository: EditorialRepository,
  ) {}

  execute(input: {
    pipelineJobId: string;
    expectedRevision: number;
    idempotencyKey: string;
    processingTemplateRevisionId: string;
    title?: string | null;
    description?: string | null;
    tags?: string[] | null;
    thumbnailAssetId?: string | null;
    metadataProvenance?: {
      mode: "AI_ASSISTED" | "MIXED";
      basisVersion: string;
      researchIntentId: string;
      suggestionSetId: string;
    };
    thumbnailProvenance?: {
      mode: "MANUAL" | "AI_ASSISTED" | "MIXED";
      basisVersion: string;
      imageIntentId?: string;
      imageCandidateId?: string;
    };
  }) {
    const snapshot = {
      pipelineJobId: input.pipelineJobId,
      expectedRevision: input.expectedRevision,
      processingTemplateRevisionId: input.processingTemplateRevisionId,
      title: input.title ?? null,
      description: input.description ?? null,
      tags: input.tags ?? null,
      thumbnailAssetId: input.thumbnailAssetId ?? null,
      metadataProvenance: input.metadataProvenance ?? null,
      thumbnailProvenance: input.thumbnailProvenance ?? null,
    };
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    return this.repository.savePackage({
      packageId: randomUUID(),
      revisionId: randomUUID(),
      mutationId: randomUUID(),
      generatedThumbnailAssetId:
        input.thumbnailProvenance?.imageCandidateId ? randomUUID() : null,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      ...snapshot,
    });
  }
}
