import { describe, expect, it } from "vitest";

import {
  projectPublicApprovalEconomicsV2,
  projectPublicApprovalProcessingMetrics,
} from "./editorial-approval-snapshot.js";

const economics = {
  schemaVersion: "approval-economics-v2",
  workflowMode: "MIXED",
  attentionSchemaVersion: "operator-attention-v2",
  preparationForegroundMs: 1_000,
  finalReviewForegroundMs: 2_000,
  totalOperatorAttentionMs: 3_000,
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
};

const jobMetrics = {
  initialQueueWaitMs: 1,
  retryWaitMs: 0,
  firstStartToFinishMs: 2,
  activeAttemptMs: 2,
  attemptCount: 1,
  retryCount: 0,
};
const metrics = {
  metricsSchemaVersion: "approval-metrics-v1",
  timestampBasisVersion: "persisted-job-attempt-v1",
  cut: jobMetrics,
  assembly: jobMetrics,
  cutToAssemblyReadyElapsedMs: 4,
  outputDurationMs: 1_000,
  outputBytes: "10",
  manualAttentionMs: 3_000,
  attentionMeasurementVersion: "operator-attention-v2",
  directProviderCostMinor: "0",
  costCurrency: "RUB",
  costBasisVersion: "local-direct-provider-cost-v1",
  incompleteReasons: ["CUT_RETRY_WAIT_TIMESTAMP_MISSING"],
};

describe("public approval snapshot projection", () => {
  it("projects valid economics and rejects arithmetic, extra fields, and arbitrary reasons", () => {
    expect(projectPublicApprovalEconomicsV2(economics)).toEqual(economics);
    expect(
      projectPublicApprovalEconomicsV2({ ...economics, credentials: "secret" }),
    ).toBeNull();
    expect(
      projectPublicApprovalEconomicsV2({
        ...economics,
        combinedDirectCostMicrousd: "7",
      }),
    ).toBeNull();
    expect(
      projectPublicApprovalEconomicsV2({
        ...economics,
        incompleteReasons: ["secret"],
      }),
    ).toBeNull();
  });

  it("projects valid metrics and rejects nested extras and arbitrary reasons", () => {
    expect(projectPublicApprovalProcessingMetrics(metrics)).toEqual(metrics);
    expect(
      projectPublicApprovalProcessingMetrics({
        ...metrics,
        credentials: "secret",
      }),
    ).toBeNull();
    expect(
      projectPublicApprovalProcessingMetrics({
        ...metrics,
        cut: { ...jobMetrics, prompt: "secret" },
      }),
    ).toBeNull();
    expect(
      projectPublicApprovalProcessingMetrics({
        ...metrics,
        incompleteReasons: ["secret"],
      }),
    ).toBeNull();
  });
});
