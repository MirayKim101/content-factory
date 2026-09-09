import { describe, expect, it } from "vitest";

import { calculateApprovalProcessingMetrics } from "../src/editorial-content/domain/editorial-approval.js";

const at = (seconds: number) => new Date(seconds * 1_000);

describe("approval-metrics-v1", () => {
  it("keeps initial queue, retry wait, active work, elapsed time, and retries distinct", () => {
    const metrics = calculateApprovalProcessingMetrics({
      cut: {
        queuedAt: at(0),
        finishedAt: at(110),
        attempts: [
          { attemptNumber: 1, startedAt: at(10), finishedAt: at(40) },
          { attemptNumber: 2, startedAt: at(60), finishedAt: at(110) },
        ],
      },
      assembly: {
        queuedAt: at(0),
        finishedAt: at(110),
        attempts: [
          { attemptNumber: 2, startedAt: at(60), finishedAt: at(110) },
          { attemptNumber: 1, startedAt: at(10), finishedAt: at(40) },
        ],
      },
      outputDurationMs: 30_000,
      outputBytes: 42n,
    });

    expect(metrics.cut).toEqual({
      initialQueueWaitMs: 10_000,
      retryWaitMs: 20_000,
      activeAttemptMs: 80_000,
      firstStartToFinishMs: 100_000,
      attemptCount: 2,
      retryCount: 1,
    });
    expect(metrics.assembly).toEqual(metrics.cut);
    expect(metrics.cutToAssemblyReadyElapsedMs).toBe(110_000);
    expect(metrics.incompleteReasons).toEqual([]);
    expect(metrics).toMatchObject({
      metricsSchemaVersion: "approval-metrics-v1",
      timestampBasisVersion: "persisted-job-attempt-v1",
      directProviderCostMinor: 0,
      costCurrency: "RUB",
      costBasisVersion: "local-direct-provider-cost-v1",
    });
  });

  it("uses the cut queue and assembly finish for calendar end-to-end elapsed time", () => {
    const metrics = calculateApprovalProcessingMetrics({
      cut: {
        queuedAt: at(0),
        finishedAt: at(30),
        attempts: [{ attemptNumber: 1, startedAt: at(1), finishedAt: at(30) }],
      },
      assembly: {
        queuedAt: at(120),
        finishedAt: at(180),
        attempts: [
          { attemptNumber: 1, startedAt: at(125), finishedAt: at(180) },
        ],
      },
      outputDurationMs: 30_000,
      outputBytes: 42n,
    });
    expect(metrics.cutToAssemblyReadyElapsedMs).toBe(180_000);
  });

  it("preserves recovery-written invalid order without sorting or clamping wall time", () => {
    const metrics = calculateApprovalProcessingMetrics({
      cut: {
        queuedAt: at(0),
        finishedAt: at(50),
        attempts: [
          { attemptNumber: 1, startedAt: at(10), finishedAt: at(40) },
          { attemptNumber: 2, startedAt: at(35), finishedAt: at(34) },
        ],
      },
      assembly: {
        queuedAt: at(0),
        finishedAt: at(50),
        attempts: [{ attemptNumber: 1, startedAt: at(10), finishedAt: at(50) }],
      },
      outputDurationMs: 30_000,
      outputBytes: 42n,
    });
    expect(metrics.cut).toEqual({
      initialQueueWaitMs: 10_000,
      retryWaitMs: null,
      activeAttemptMs: null,
      firstStartToFinishMs: 40_000,
      attemptCount: 2,
      retryCount: 1,
    });
    expect(metrics.incompleteReasons).toEqual([
      "CUT_RETRY_WAIT_TIMESTAMP_CLOCK_SKEW_SUSPECTED",
      "CUT_ACTIVE_ATTEMPT_TIMESTAMP_ORDER_INVALID",
    ]);
  });

  it("returns field-specific null reasons for missing persisted boundaries", () => {
    const metrics = calculateApprovalProcessingMetrics({
      cut: { queuedAt: at(0), finishedAt: null, attempts: [] },
      assembly: {
        queuedAt: at(10),
        finishedAt: null,
        attempts: [{ attemptNumber: 1, startedAt: at(20), finishedAt: null }],
      },
      outputDurationMs: 30_000,
      outputBytes: 42n,
    });
    expect(metrics.cut).toMatchObject({
      initialQueueWaitMs: null,
      firstStartToFinishMs: null,
      activeAttemptMs: 0,
      attemptCount: 0,
      retryCount: 0,
    });
    expect(metrics.assembly).toMatchObject({
      initialQueueWaitMs: 10_000,
      firstStartToFinishMs: null,
      activeAttemptMs: null,
      attemptCount: 1,
      retryCount: 0,
    });
    expect(metrics.cutToAssemblyReadyElapsedMs).toBeNull();
    expect(metrics.incompleteReasons).toEqual([
      "CUT_INITIAL_QUEUE_WAIT_TIMESTAMP_MISSING",
      "CUT_FIRST_START_TO_FINISH_TIMESTAMP_MISSING",
      "ASSEMBLY_FIRST_START_TO_FINISH_TIMESTAMP_MISSING",
      "ASSEMBLY_ACTIVE_ATTEMPT_TIMESTAMP_MISSING",
      "CUT_TO_ASSEMBLY_READY_TIMESTAMP_MISSING",
    ]);
  });
});
