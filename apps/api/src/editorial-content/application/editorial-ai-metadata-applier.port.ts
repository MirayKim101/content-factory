import type { EditorialPackageView } from "../domain/editorial.js";

export const EDITORIAL_AI_METADATA_APPLIER = Symbol(
  "EDITORIAL_AI_METADATA_APPLIER",
);

export interface EditorialAiMetadataApplier {
  apply(input: {
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
  }): Promise<EditorialPackageView>;
}
