import { describe, expect, it, vi } from "vitest";

import { CollectPublicationMetrics } from "../src/application/collect-publication-metrics.js";
import type {
  PublicationMetricsClaim,
  PublicationWorkerRepository,
} from "../src/application/publication.port.js";

const claim: PublicationMetricsClaim = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  externalChannelRef: "UC1234567890123456789012",
  platform: "YOUTUBE",
  remotePublicationId: "video_42",
  metricsLeaseToken: "00000000-0000-4000-8000-000000000003",
};

function repository(): PublicationWorkerRepository {
  return {
    claim: vi.fn(),
    heartbeat: vi.fn(),
    finalizeDryRun: vi.fn(),
    finalizePublishedDirect: vi.fn(),
    releaseForRetry: vi.fn(),
    failFinal: vi.fn(),
    markUnknownRemoteState: vi.fn(),
    unknownRemoteOutcomes: vi.fn(),
    heartbeatReconciliationClaim: vi.fn(),
    refreshUnknownRemoteState: vi.fn(),
    finalizePublished: vi.fn(),
    failUnknownRemoteState: vi.fn(),
    releaseReconciliationClaim: vi.fn(),
    claimPublishedForMetrics: vi.fn().mockResolvedValue([claim]),
    recordMetrics: vi.fn().mockResolvedValue(true),
    releaseMetricsClaim: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CollectPublicationMetrics", () => {
  it("stores a fenced immutable metrics snapshot", async () => {
    const repo = repository();
    const snapshot = {
      adapterVersion: "youtube-data-v3-statistics",
      viewCount: 101n,
      likeCount: 12n,
      commentCount: 3n,
      shareCount: null,
    };
    const provider = {
      platform: "YOUTUBE" as const,
      publish: vi.fn(),
      metrics: vi.fn().mockResolvedValue(snapshot),
    };

    await expect(
      new CollectPublicationMetrics(repo, [provider]).execute(),
    ).resolves.toBe(1);

    expect(provider.metrics).toHaveBeenCalledWith(
      claim,
      expect.any(AbortSignal),
    );
    expect(repo.recordMetrics).toHaveBeenCalledWith(
      claim,
      snapshot,
      expect.any(Date),
    );
  });

  it("releases a claim after provider failure", async () => {
    const repo = repository();
    const onFailure = vi.fn();
    const provider = {
      platform: "YOUTUBE" as const,
      publish: vi.fn(),
      metrics: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    };

    await expect(
      new CollectPublicationMetrics(
        repo,
        [provider],
        undefined,
        onFailure,
      ).execute(),
    ).resolves.toBe(0);

    expect(repo.releaseMetricsClaim).toHaveBeenCalledWith(claim);
    expect(onFailure).toHaveBeenCalledWith(claim.id, expect.any(Error));
  });

  it("releases claims when the configured adapter has no metrics capability", async () => {
    const repo = repository();
    await expect(
      new CollectPublicationMetrics(repo, []).execute(),
    ).resolves.toBe(0);
    expect(repo.releaseMetricsClaim).toHaveBeenCalledWith(claim);
  });
});
