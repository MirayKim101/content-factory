import { describe, expect, it } from "vitest";

import {
  createEditorialApprovalsApi,
  componentSummarySchema,
  EditorialApprovalApiError,
  editorialApprovalEconomicsV2Schema,
  noLikenessSafetyDecisionSchema,
  processingMetricsSchema,
} from "~/shared/api/editorial-approvals";

const cutId = "00000000-0000-4000-8000-000000000001";
const renderId = "00000000-0000-4000-8000-000000000002";

function failure(status: number) {
  return async () =>
    new Response(
      JSON.stringify({ error: { code: `HTTP_${status}`, message: "blocked" } }),
      { status },
    );
}

describe("editorial approvals API", () => {
  it("accepts only the exact public no-likeness safety contract", () => {
    const exact = {
      version: "no-likeness-safety-v1",
      realisticPersonRequested: false,
      referenceImageUsed: false,
      externalProviderUsed: false,
    } as const;
    expect(noLikenessSafetyDecisionSchema.parse(exact)).toEqual(exact);
    expect(() =>
      noLikenessSafetyDecisionSchema.parse({
        ...exact,
        credentials: "must-not-cross-public-api",
      }),
    ).toThrow();
  });

  it("parses exact v2 economics and rejects inconsistent or extra data", () => {
    const economics = {
      schemaVersion: "approval-economics-v2",
      workflowMode: "MIXED",
      attention: {
        schemaVersion: "operator-attention-v2",
        preparationForegroundMs: 10,
        finalReviewForegroundMs: 20,
        totalOperatorAttentionMs: 30,
      },
      metadataDirectCostMicrousd: "1",
      evidenceDirectCostMicrousd: "2",
      thumbnailDirectCostMicrousd: "3",
      combinedDirectCostMicrousd: "6",
      currency: "USD",
      unit: "MICRO",
      metadataCostBasisVersion: "metadata-v1",
      evidenceCostBasisVersion: "evidence-v1",
      thumbnailCostBasisVersion: "thumbnail-v1",
      assistanceTiming: null,
      incompleteReasons: [],
      snapshotFingerprint: "a".repeat(64),
    } as const;
    expect(editorialApprovalEconomicsV2Schema.parse(economics)).toEqual(
      economics,
    );
    expect(() =>
      editorialApprovalEconomicsV2Schema.parse({
        ...economics,
        combinedDirectCostMicrousd: "7",
      }),
    ).toThrow();
    expect(() =>
      editorialApprovalEconomicsV2Schema.parse({ ...economics, secret: true }),
    ).toThrow();
    expect(() =>
      editorialApprovalEconomicsV2Schema.parse({
        ...economics,
        incompleteReasons: ["secret"],
      }),
    ).toThrow();
    expect(() =>
      editorialApprovalEconomicsV2Schema.parse({
        ...economics,
        assistanceTiming: {},
      }),
    ).toThrow();
  });

  it("rejects arbitrary component and processing snapshot values", () => {
    expect(() =>
      componentSummarySchema.parse({
        component: "METADATA",
        provenanceId: cutId,
        mode: "MANUAL",
        basisVersion: "manual-v1",
        researchIntentId: null,
        suggestionSetId: null,
        imageIntentId: null,
        imageCandidateId: null,
        transcriptArtifactId: null,
        transcriptSha256: null,
        citations: [],
        research: null,
        imageSafetyDecision: null,
        likeness: "PRIVATE_PERSON",
        directCostMicrousd: "0",
        costBasisVersion: "manual-v1",
        incompleteReasons: ["operator secret"],
        snapshotFingerprint: "a".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      processingMetricsSchema.parse({
        metricsSchemaVersion: "approval-metrics-v1",
        timestampBasisVersion: "persisted-job-attempt-v1",
        cut: {
          initialQueueWaitMs: 0,
          retryWaitMs: 0,
          firstStartToFinishMs: 1,
          activeAttemptMs: 1,
          attemptCount: 1,
          retryCount: 0,
        },
        assembly: {
          initialQueueWaitMs: 0,
          retryWaitMs: 0,
          firstStartToFinishMs: 1,
          activeAttemptMs: 1,
          attemptCount: 1,
          retryCount: 0,
        },
        cutToAssemblyReadyElapsedMs: 1,
        outputDurationMs: 1,
        outputBytes: "1",
        directProviderCostMinor: 0,
        costCurrency: "RUB",
        costBasisVersion: "local-direct-provider-cost-v1",
        incompleteReasons: ["operator secret"],
      }),
    ).toThrow();
  });

  it.each([404, 409])(
    "keeps review HTTP %i explicit and never fabricates a candidate",
    async (status) => {
      const api = createEditorialApprovalsApi("/api/v1", failure(status));
      await expect(api.review(cutId)).rejects.toEqual(
        expect.objectContaining<Partial<EditorialApprovalApiError>>({
          code: `HTTP_${status}`,
          status,
        }),
      );
    },
  );

  it.each([404, 409, 503])(
    "keeps approval HTTP %i explicit for safe dialog handling",
    async (status) => {
      const api = createEditorialApprovalsApi("/api/v1", failure(status));
      await expect(
        api.approve(
          renderId,
          {
            editorialRevision: 1,
            candidateFingerprint: "a".repeat(64),
            manualAttentionMs: 0,
            attentionMeasurementVersion: "foreground-preview-v1",
          },
          "durable-key",
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<EditorialApprovalApiError>>({
          code: `HTTP_${status}`,
          status,
        }),
      );
    },
  );
});
