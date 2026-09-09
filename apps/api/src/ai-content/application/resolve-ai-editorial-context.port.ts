import { Inject, Injectable } from "@nestjs/common";

import type { AiCapability } from "../domain/creator-context.js";
import {
  CREATOR_CONTEXT_REPOSITORY,
  type CreatorContextRepository,
} from "./creator-context-repository.port.js";

export const RESOLVE_AI_EDITORIAL_CONTEXT = Symbol(
  "RESOLVE_AI_EDITORIAL_CONTEXT",
);

export type AiEditorialContextBlocker =
  | "CUT_LINEAGE_UNUSABLE"
  | "CUT_PROMPT_MISSING"
  | "CUT_LINEAGE_CHANGED"
  | "CUT_PROMPT_REVISION_STALE"
  | "SOURCE_CONTEXT_REVISION_STALE"
  | "CREATOR_PROFILE_REVISION_STALE"
  | "REALISTIC_LIKENESS_NOT_SELECTED"
  | "DEFAULT_REFERENCE_MISSING"
  | "DEFAULT_REFERENCE_NOT_READY"
  | "DEFAULT_REFERENCE_AUTHORIZATION_MISSING"
  | "DEFAULT_REFERENCE_AUTHORIZATION_REVOKED"
  | "DEFAULT_REFERENCE_AUTHORIZATION_EXPIRED"
  | "DEFAULT_REFERENCE_AUTHORIZATION_CHANGED"
  | "DEFAULT_REFERENCE_AUTHORIZATION_NOT_CLEARED";

export type AiEditorialContextChain = {
  projectId: string;
  source: {
    id: string;
    version: number;
    sha256: string;
    authorizationRevision: number;
    authorizationBasis: string;
    authorizationDeclarationVersion: string;
    authorizationDecidedAt: Date;
  };
  cut: {
    pipelineJobId: string;
    resultArtifactId: string;
    resultSha256: string;
    resultSizeBytes: bigint;
  };
  prompt: {
    id: string;
    revisionId: string;
    revision: number;
    currentRevision: number;
  };
  sourceContext: {
    id: string;
    revisionId: string;
    revision: number;
    currentRevision: number;
  };
  creatorProfile: {
    id: string;
    revisionId: string;
    revision: number;
    currentRevision: number;
  };
  reference: null | {
    assetId: string;
    assetStatus: "PENDING" | "READY" | "FAILED_FINAL";
    capturedAuthorizationRevisionId: string;
    capturedAuthorizationRevision: number;
    latestAuthorizationRevisionId: string | null;
    latestAuthorizationRevision: number | null;
    latestAuthorizationStatus: "NOT_REVIEWED" | "CLEARED" | "REVOKED" | null;
    latestAuthorizationExpiresAt: Date | null;
    externalProviderTransferAllowed: boolean;
  };
};

export type AiEditorialContextResolution = {
  capability: AiCapability;
  admitted: boolean;
  blockers: AiEditorialContextBlocker[];
  contextPolicyFingerprint: string | null;
  chain: AiEditorialContextChain | null;
};

export interface ResolveAiEditorialContextPort {
  resolve(input: {
    cutPipelineJobId: string;
    capability: AiCapability;
  }): Promise<AiEditorialContextResolution>;
}

@Injectable()
export class ResolveAiEditorialContext implements ResolveAiEditorialContextPort {
  constructor(
    @Inject(CREATOR_CONTEXT_REPOSITORY)
    private readonly repository: CreatorContextRepository,
  ) {}

  resolve(input: { cutPipelineJobId: string; capability: AiCapability }) {
    return this.repository.resolveEditorialContext(
      input.cutPipelineJobId,
      input.capability,
    );
  }
}
