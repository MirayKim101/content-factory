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
  }) {
    const snapshot = {
      pipelineJobId: input.pipelineJobId,
      expectedRevision: input.expectedRevision,
      processingTemplateRevisionId: input.processingTemplateRevisionId,
      title: input.title ?? null,
      description: input.description ?? null,
      tags: input.tags ?? null,
      thumbnailAssetId: input.thumbnailAssetId ?? null,
    };
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    return this.repository.savePackage({
      packageId: randomUUID(),
      revisionId: randomUUID(),
      mutationId: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      ...snapshot,
    });
  }
}
