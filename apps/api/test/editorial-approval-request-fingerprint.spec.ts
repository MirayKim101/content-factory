import { describe, expect, it } from "vitest";

import {
  canonicalApprovalRequestFingerprint,
  selectSuggestionCitations,
} from "../src/editorial-content/infrastructure/prisma-editorial-approval.repository.js";

const baseline = {
  approvalContractVersion: "manual-horizontal-approval-v1" as const,
  renderId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  sourceId: "00000000-0000-4000-8000-000000000003",
  sourceVersion: 7,
  cutPipelineJobId: "00000000-0000-4000-8000-000000000004",
  editorialPackageId: "00000000-0000-4000-8000-000000000005",
  editorialPackageRevisionId: "00000000-0000-4000-8000-000000000006",
  assemblyRecipeId: "00000000-0000-4000-8000-000000000007",
  recipeRevisionId: "00000000-0000-4000-8000-000000000008",
  assemblyRenderResultId: "00000000-0000-4000-8000-000000000009",
  thumbnailAssetId: "00000000-0000-4000-8000-000000000010",
  editorialRevision: 3,
  candidateFingerprint: "a".repeat(64),
  manualAttentionMs: 1_234,
  attentionMeasurementVersion: "foreground-preview-v1",
};

describe("editorial approval request fingerprint migration boundary", () => {
  it("preserves the exact v1 hash for historical same-key replay", () => {
    const knownBaselineHash =
      "e322ccac9d5068b20ece2933fb55fca664ed2ab5990709a6e83efb96cf0382fa";
    expect(canonicalApprovalRequestFingerprint(baseline)).toBe(
      knownBaselineHash,
    );
    expect(canonicalApprovalRequestFingerprint({ ...baseline })).toBe(
      knownBaselineHash,
    );
  });

  it("adds split attention only to the v2 tuple", () => {
    const first = canonicalApprovalRequestFingerprint({
      ...baseline,
      approvalContractVersion: "human-horizontal-approval-v2",
      manualAttentionMs: undefined,
      attentionMeasurementVersion: undefined,
      attention: {
        schemaVersion: "operator-attention-v2",
        preparationForegroundMs: 100,
        finalReviewForegroundMs: 1_134,
      },
    });
    const second = canonicalApprovalRequestFingerprint({
      ...baseline,
      approvalContractVersion: "human-horizontal-approval-v2",
      manualAttentionMs: undefined,
      attentionMeasurementVersion: undefined,
      attention: {
        schemaVersion: "operator-attention-v2",
        preparationForegroundMs: 101,
        finalReviewForegroundMs: 1_133,
      },
    });
    expect(first).not.toBe(second);
    expect(first).not.toBe(canonicalApprovalRequestFingerprint(baseline));
  });
});

describe("approval metadata citation snapshot", () => {
  const first = {
    id: "00000000-0000-4000-8000-000000000101",
    url: "https://example.com/first",
    title: "First",
    publisher: "Example",
    publishedAt: null,
    accessedAt: new Date("2026-09-24T00:00:00.000Z"),
  };
  const second = {
    ...first,
    id: "00000000-0000-4000-8000-000000000102",
    url: "https://example.com/second",
    title: "Second",
  };
  const unused = {
    ...first,
    id: "00000000-0000-4000-8000-000000000103",
    url: "https://example.com/unused",
    title: "Unused",
  };

  it("keeps only declared citations in their exact declared order", () => {
    expect(
      selectSuggestionCitations([first, second, unused], [second.id, first.id]),
    ).toEqual([second, first]);
  });

  it("rejects duplicate, unknown, missing, and ambiguous citation identities", () => {
    expect(selectSuggestionCitations([first], [first.id, first.id])).toBeNull();
    expect(selectSuggestionCitations([first], [second.id])).toBeNull();
    expect(selectSuggestionCitations([first], null)).toBeNull();
    expect(selectSuggestionCitations([first, first], [first.id])).toBeNull();
  });
});
