/** Owned, provider-free facts consumed by independent API and worker adapters.
 * Adapters must acquire the documented current-row locks before using these
 * facts to admit, claim, read, or finalize. This pure evaluator takes no locks.
 */
export interface FrameContextCapture {
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceSha256: string;
  sourceAuthorizationRevision: number;
  sourceAuthorizationBasis: string;
  sourceAuthorizationDeclarationVersion: string;
  sourceAuthorizationDecidedAt: string;
  cutPipelineJobId: string;
  cutResultArtifactId: string;
  cutResultSha256: string;
  cutResultSizeBytes: string;
  cutStartMs: number;
  cutEndMs: number;
  creatorProfileId: string;
  creatorProfileRevisionId: string;
  creatorProfileRevisionNo: number;
  sourceContextId: string;
  sourceContextRevisionId: string;
  sourceContextRevisionNo: number;
  cutPromptId: string;
  cutPromptRevisionId: string;
  cutPromptRevisionNo: number;
}

export interface FrameContextFacts {
  capture: FrameContextCapture;
  sourceStatus: string;
  sourceCurrentVersion: number;
  sourceAuthorizationStatus: string | null;
  cutJobType: string;
  cutJobState: string;
  cutArtifactRole: string;
  cutArtifactStatus: string;
  exactLineage: boolean;
  creatorProfileCurrentRevision: number;
  sourceContextCurrentRevision: number;
  cutPromptCurrentRevision: number;
}

export type FrameContextBlocker =
  | "SOURCE_AUTHORIZATION_REQUIRED"
  | "CUT_LINEAGE_UNUSABLE"
  | "CREATOR_PROFILE_REVISION_STALE"
  | "SOURCE_CONTEXT_REVISION_STALE"
  | "CUT_PROMPT_REVISION_STALE"
  | "CAPTURED_CONTEXT_CHANGED";

/** Intentionally excludes reference photographs and their authorization. */
export function framePolicyMaterial(capture: FrameContextCapture): string {
  return JSON.stringify([
    "ai-frame-context-policy-v1",
    "FRAME_EXTRACTION",
    capture.projectId,
    capture.sourceId,
    capture.sourceVersion,
    capture.sourceSha256,
    capture.sourceAuthorizationRevision,
    capture.sourceAuthorizationBasis,
    capture.sourceAuthorizationDeclarationVersion,
    capture.sourceAuthorizationDecidedAt,
    capture.cutPipelineJobId,
    capture.cutResultArtifactId,
    capture.cutResultSha256,
    capture.cutResultSizeBytes,
    capture.cutStartMs,
    capture.cutEndMs,
    capture.creatorProfileId,
    capture.creatorProfileRevisionId,
    capture.creatorProfileRevisionNo,
    capture.sourceContextId,
    capture.sourceContextRevisionId,
    capture.sourceContextRevisionNo,
    capture.cutPromptId,
    capture.cutPromptRevisionId,
    capture.cutPromptRevisionNo,
  ]);
}

export function frameSourceBytesReadable(
  facts: FrameContextFacts,
  sourcePolicy: "manual" | "local-auto",
): boolean {
  return (
    facts.sourceStatus === "READY" &&
    facts.sourceCurrentVersion === facts.capture.sourceVersion &&
    facts.sourceAuthorizationStatus === "CLEARED" &&
    [
      "LEGACY_ATTESTATION",
      "OPERATOR_ATTESTATION",
      "LOCAL_DEVELOPMENT_AUTO",
    ].includes(facts.capture.sourceAuthorizationBasis) &&
    (facts.capture.sourceAuthorizationBasis !== "LOCAL_DEVELOPMENT_AUTO" ||
      sourcePolicy === "local-auto") &&
    facts.capture.sourceAuthorizationDeclarationVersion.length > 0 &&
    Number.isFinite(Date.parse(facts.capture.sourceAuthorizationDecidedAt))
  );
}

export function frameContextBlockers(
  facts: FrameContextFacts,
  sourcePolicy: "manual" | "local-auto",
  captured?: FrameContextCapture,
): FrameContextBlocker[] {
  const blockers: FrameContextBlocker[] = [];
  if (!frameSourceBytesReadable(facts, sourcePolicy))
    blockers.push("SOURCE_AUTHORIZATION_REQUIRED");
  if (
    !facts.exactLineage ||
    facts.cutJobType !== "CUT_SEGMENT" ||
    facts.cutJobState !== "READY" ||
    facts.cutArtifactRole !== "CUT_RESULT" ||
    facts.cutArtifactStatus !== "READY" ||
    !/^[0-9a-f]{64}$/.test(facts.capture.cutResultSha256) ||
    !/^[1-9][0-9]*$/.test(facts.capture.cutResultSizeBytes)
  )
    blockers.push("CUT_LINEAGE_UNUSABLE");
  if (
    facts.creatorProfileCurrentRevision !==
    facts.capture.creatorProfileRevisionNo
  )
    blockers.push("CREATOR_PROFILE_REVISION_STALE");
  if (
    facts.sourceContextCurrentRevision !== facts.capture.sourceContextRevisionNo
  )
    blockers.push("SOURCE_CONTEXT_REVISION_STALE");
  if (facts.cutPromptCurrentRevision !== facts.capture.cutPromptRevisionNo)
    blockers.push("CUT_PROMPT_REVISION_STALE");
  if (
    captured &&
    framePolicyMaterial(captured) !== framePolicyMaterial(facts.capture)
  )
    blockers.push("CAPTURED_CONTEXT_CHANGED");
  return blockers;
}
