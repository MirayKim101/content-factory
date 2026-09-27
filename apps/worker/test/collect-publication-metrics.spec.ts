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
    releaseClaim: vi.fn().mockResolvedValue(true),
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
    heartbeatMetricsClaim: vi.fn().mockResolvedValue(true),
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

  it("heartbeats later claims while they wait for metrics collection", async () => {
    vi.useFakeTimers();
    try {
      const second = { ...claim, id: "00000000-0000-4000-8000-000000000009" };
      const repo = repository();
      vi.mocked(repo.claimPublishedForMetrics).mockResolvedValue([
        claim,
        second,
      ]);
      let finishFirst: (() => void) | undefined;
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
        metrics: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<typeof snapshot>((resolve) => {
                finishFirst = () => resolve(snapshot);
              }),
          )
          .mockResolvedValueOnce(snapshot),
      };

      const execution = new CollectPublicationMetrics(
        repo,
        [provider],
        undefined,
        undefined,
        60_000,
      ).execute();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(repo.heartbeatMetricsClaim).toHaveBeenCalledWith(
        second,
        expect.any(Date),
      );
      expect(provider.metrics).toHaveBeenCalledTimes(1);

      finishFirst?.();
      await expect(execution).resolves.toBe(2);
      expect(provider.metrics).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts metrics collection when heartbeat ownership is lost", async () => {
    vi.useFakeTimers();
    try {
      const repo = repository();
      vi.mocked(repo.heartbeatMetricsClaim).mockResolvedValue(false);
      const onFailure = vi.fn();
      const provider = {
        platform: "YOUTUBE" as const,
        publish: vi.fn(),
        metrics: vi.fn(
          (_claim: PublicationMetricsClaim, signal?: AbortSignal) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        ),
      };

      const execution = new CollectPublicationMetrics(
        repo,
        [provider],
        undefined,
        onFailure,
        60_000,
      ).execute();
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(execution).resolves.toBe(0);
      expect(repo.recordMetrics).not.toHaveBeenCalled();
      expect(repo.releaseMetricsClaim).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and releases active metrics collection during shutdown", async () => {
    const repo = repository();
    const onFailure = vi.fn();
    const provider = {
      platform: "YOUTUBE" as const,
      publish: vi.fn(),
      metrics: vi.fn(
        (_claim: PublicationMetricsClaim, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    };
    const collector = new CollectPublicationMetrics(
      repo,
      [provider],
      undefined,
      onFailure,
    );

    const execution = collector.execute();
    await vi.waitFor(() => expect(provider.metrics).toHaveBeenCalledOnce());
    collector.abortAll();

    await expect(execution).resolves.toBe(0);
    expect(repo.releaseMetricsClaim).toHaveBeenCalledWith(claim);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
