import { describe, expect, it } from "vitest";

import {
  NO_LIKENESS_SAFETY_DECISION_VERSION,
  parseMediaJobReference,
  projectNoLikenessSafetyDecision,
} from "./index.js";

describe("MediaJobReferenceV1", () => {
  it("accepts the versioned reference-only payload", () => {
    expect(
      parseMediaJobReference({
        schemaVersion: 1,
        jobId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      schemaVersion: 1,
      jobId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects unknown versions and embedded work details", () => {
    expect(() =>
      parseMediaJobReference({
        schemaVersion: 2,
        jobId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("JOB_PAYLOAD_INVALID");
  });
});

describe("NoLikenessSafetyDecision", () => {
  const decision = {
    version: NO_LIKENESS_SAFETY_DECISION_VERSION,
    realisticPersonRequested: false,
    referenceImageUsed: false,
    externalProviderUsed: false,
  } as const;

  it("returns a fixed public projection for the supported version", () => {
    expect(projectNoLikenessSafetyDecision(decision)).toEqual(decision);
  });

  it("fails closed on private or malformed fields", () => {
    expect(
      projectNoLikenessSafetyDecision({
        ...decision,
        credentials: "must-not-leak",
        prompt: "private prompt",
      }),
    ).toBeNull();
    expect(
      projectNoLikenessSafetyDecision({
        ...decision,
        externalProviderUsed: true,
      }),
    ).toBeNull();
  });
});
