import { describe, expect, it } from "vitest";
import {
  frameContextBlockers,
  framePolicyMaterial,
  frameSourceBytesReadable,
  type FrameContextFacts,
} from "@content-factory/contracts";

function current(): FrameContextFacts {
  return {
    capture: {
      projectId: "project",
      sourceId: "source",
      sourceVersion: 1,
      sourceSha256: "a".repeat(64),
      sourceAuthorizationRevision: 1,
      sourceAuthorizationBasis: "OPERATOR_ATTESTATION",
      sourceAuthorizationDeclarationVersion: "source-rights-v1",
      sourceAuthorizationDecidedAt: "2026-09-16T00:00:00.000Z",
      cutPipelineJobId: "cut",
      cutResultArtifactId: "artifact",
      cutResultSha256: "b".repeat(64),
      cutResultSizeBytes: "1024",
      cutStartMs: 1000,
      cutEndMs: 4000,
      creatorProfileId: "profile",
      creatorProfileRevisionId: "profile-r1",
      creatorProfileRevisionNo: 1,
      sourceContextId: "context",
      sourceContextRevisionId: "context-r1",
      sourceContextRevisionNo: 1,
      cutPromptId: "prompt",
      cutPromptRevisionId: "prompt-r1",
      cutPromptRevisionNo: 1,
    },
    sourceStatus: "READY",
    sourceCurrentVersion: 1,
    sourceAuthorizationStatus: "CLEARED",
    cutJobType: "CUT_SEGMENT",
    cutJobState: "READY",
    cutArtifactRole: "CUT_RESULT",
    cutArtifactStatus: "READY",
    exactLineage: true,
    creatorProfileCurrentRevision: 1,
    sourceContextCurrentRevision: 1,
    cutPromptCurrentRevision: 1,
  };
}

describe("FRAME_EXTRACTION capability policy shared by independent adapters", () => {
  it("admits no-reference profiles and ignores unrelated reference revocation/re-clear", () => {
    const facts = current();
    expect(frameContextBlockers(facts, "manual")).toEqual([]);
    const before = framePolicyMaterial({
      ...facts.capture,
      reference: { status: "CLEARED", revision: 1 },
    } as typeof facts.capture);
    const after = framePolicyMaterial({
      ...facts.capture,
      reference: { status: "REVOKED", revision: 2 },
    } as typeof facts.capture);
    expect(after).toBe(before);
    expect(
      framePolicyMaterial({
        ...facts.capture,
        reference: { status: "CLEARED", revision: 3 },
      } as typeof facts.capture),
    ).toBe(before);
  });

  it.each([
    ["creatorProfileCurrentRevision", "CREATOR_PROFILE_REVISION_STALE"],
    ["sourceContextCurrentRevision", "SOURCE_CONTEXT_REVISION_STALE"],
    ["cutPromptCurrentRevision", "CUT_PROMPT_REVISION_STALE"],
  ] as const)(
    "stale %s blocks new use while historical bytes remain readable",
    (field, blocker) => {
      const facts = current();
      facts[field] = 2;
      expect(frameContextBlockers(facts, "manual")).toContain(blocker);
      expect(frameSourceBytesReadable(facts, "manual")).toBe(true);
    },
  );

  it("revoked/noncurrent rights deny bytes; reauthorization restores bytes without restoring captured generation identity", () => {
    const facts = current();
    const captured = { ...facts.capture };
    facts.sourceAuthorizationStatus = "NOT_REVIEWED";
    expect(frameSourceBytesReadable(facts, "manual")).toBe(false);
    facts.sourceAuthorizationStatus = "CLEARED";
    facts.capture.sourceAuthorizationRevision = 3;
    expect(frameSourceBytesReadable(facts, "manual")).toBe(true);
    expect(frameContextBlockers(facts, "manual", captured)).toEqual([
      "CAPTURED_CONTEXT_CHANGED",
    ]);
    facts.sourceCurrentVersion = 2;
    expect(frameSourceBytesReadable(facts, "manual")).toBe(false);
  });

  it("applies manual/local source policy and exact result identity", () => {
    const facts = current();
    facts.capture.sourceAuthorizationBasis = "LOCAL_DEVELOPMENT_AUTO";
    expect(frameContextBlockers(facts, "manual")).toEqual([
      "SOURCE_AUTHORIZATION_REQUIRED",
    ]);
    expect(frameContextBlockers(facts, "local-auto")).toEqual([]);
    facts.exactLineage = false;
    expect(frameContextBlockers(facts, "local-auto")).toEqual([
      "CUT_LINEAGE_UNUSABLE",
    ]);
  });
});
