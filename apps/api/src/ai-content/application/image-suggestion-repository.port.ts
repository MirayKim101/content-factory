import type { NoLikenessSafetyDecision } from "@content-factory/contracts";

export const IMAGE_SUGGESTION_REPOSITORY = Symbol(
  "IMAGE_SUGGESTION_REPOSITORY",
);

export type ImageSuggestionView = {
  id: string;
  projectId: string;
  cutPipelineJobId: string;
  state: "QUEUED" | "PROCESSING" | "READY" | "FAILED_FINAL";
  contractVersion: string;
  adapterVersion: string;
  promptBasisVersion: string;
  candidate: null | {
    id: string;
    contentType: "image/png";
    sizeBytes: string;
    sha256: string;
    width: number;
    height: number;
    likeness: "NONE";
    safetyDecision: NoLikenessSafetyDecision;
    directCostMicrousd: string;
    costBasisVersion: string;
  };
  failure: null | { code: string; message: string };
  createdAt: Date;
  updatedAt: Date;
};

export interface ImageSuggestionRepository {
  create(input: {
    projectId: string;
    cutPipelineJobId: string;
    sourceContextRevisionId: string;
    cutPromptRevisionId: string;
    idempotencyKey: string;
  }): Promise<string>;
  detail(intentId: string): Promise<ImageSuggestionView | null>;
  list(cutPipelineJobId: string): Promise<ImageSuggestionView[]>;
  resolveForApply(intentId: string): Promise<{
    pipelineJobId: string;
    imageIntentId: string;
    candidate: NonNullable<ImageSuggestionView["candidate"]>;
  }>;
  resolveContent(intentId: string, candidateId: string): Promise<{
    projectId: string;
    objectKey: string;
    contentType: "image/png";
    sizeBytes: bigint;
    sha256: string;
  } | null>;
}

export class ImageSuggestionContextRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
