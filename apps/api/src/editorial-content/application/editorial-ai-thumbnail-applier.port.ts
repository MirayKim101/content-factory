import type { EditorialPackageView } from "../domain/editorial.js";

export const EDITORIAL_AI_THUMBNAIL_APPLIER = Symbol(
  "EDITORIAL_AI_THUMBNAIL_APPLIER",
);

export interface EditorialAiThumbnailApplier {
  replay(input: {
    pipelineJobId: string;
    expectedRevision: number;
    idempotencyKey: string;
    provenance: {
      mode: "AI_ASSISTED";
      basisVersion: string;
      imageIntentId: string;
      imageCandidateId: string;
    };
  }): Promise<EditorialPackageView | null>;
  apply(input: {
    pipelineJobId: string;
    expectedRevision: number;
    idempotencyKey: string;
    provenance: {
      mode: "AI_ASSISTED";
      basisVersion: string;
      imageIntentId: string;
      imageCandidateId: string;
    };
  }): Promise<EditorialPackageView>;
}
