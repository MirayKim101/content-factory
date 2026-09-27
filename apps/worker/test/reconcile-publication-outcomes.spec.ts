import { describe, expect, it, vi } from "vitest";

import type {
  PublicationReconciliationClaim,
  PublicationWorkerRepository,
} from "../src/application/publication.port.js";
import { ReconcilePublicationOutcomes } from "../src/application/reconcile-publication-outcomes.js";

const claim: PublicationReconciliationClaim = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000003",
  externalChannelRef: "youtube-channel-7",
  platform: "YOUTUBE",
  contentKind: "VERTICAL_RESULT",
  contentId: "00000000-0000-4000-8000-000000000002",
  contentObjectKey: "vertical/release.mp4",
  contentSizeBytes: 1024n,
  contentSha256: "b".repeat(64),
  contentType: "video/mp4",
  metadataSnapshot: { title: "Release" },
  attemptNumber: 1,
  remotePublicationId: "youtube-video-42",
  reconciliationLeaseToken: "00000000-0000-4000-8000-000000000004",
};

function repository(): PublicationWorkerRepository {
  return {
    claim: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue(true),
    releaseClaim: vi.fn().mockResolvedValue(true),
    finalizeDryRun: vi.fn(),
    finalizePublishedDirect: vi.fn(),
    releaseForRetry: vi.fn(),
    failFinal: vi.fn(),
    markUnknownRemoteState: vi.fn(),
    unknownRemoteOutcomes: vi.fn().mockResolvedValue([claim]),
    heartbeatReconciliationClaim: vi.fn().mockResolvedValue(true),
    refreshUnknownRemoteState: vi.fn().mockResolvedValue(true),
    finalizePublished: vi.fn().mockResolvedValue(true),
    failUnknownRemoteState: vi.fn().mockResolvedValue(true),
    releaseReconciliationClaim: vi.fn().mockResolvedValue(undefined),
    claimPublishedForMetrics: vi.fn().mockResolvedValue([]),
    heartbeatMetricsClaim: vi.fn().mockResolvedValue(true),
    recordMetrics: vi.fn().mockResolvedValue(true),
    releaseMetricsClaim: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ReconcilePublicationOutcomes", () => {
  it("keeps a pending remote publication quarantined", async () => {
    const repo = repository();
    const provider = {
      platform: "YOUTUBE" as const,
      publish: vi.fn(),
      reconcile: vi
        .fn()
        .mockResolvedValue({ state: "PENDING", remoteStatus: "processing" }),
    };

    await expect(
      new ReconcilePublicationOutcomes(repo, [provider]).execute(),
    ).resolves.toBe(1);

    expect(repo.refreshUnknownRemoteState).toHaveBeenCalledWith(
      claim,
      "processing",
      expect.any(Date),
    );
    expect(repo.finalizePublished).not.toHaveBeenCalled();
  });

  it("finalizes a publication confirmed by provider status polling", async () => {
    const repo = repository();
    const result = {
      state: "PUBLISHED" as const,
      remoteStatus: "published",
      adapterVersion: "youtube-v1",
      providerReceipt: { id: claim.remotePublicationId },
      publicUrl: "https://youtu.be/youtube-video-42",
    };
    const provider = {
      platform: "YOUTUBE" as const,
      publish: vi.fn(),
      reconcile: vi.fn().mockResolvedValue(result),
    };

    await new ReconcilePublicationOutcomes(repo, [provider]).execute();

    expect(repo.finalizePublished).toHaveBeenCalledWith(
      claim,
      result,
      expect.any(Date),
    );
  });

  it("does not mutate unknown outcomes without a matching status adapter", async () => {
    const repo = repository();

    await expect(
      new ReconcilePublicationOutcomes(repo, []).execute(),
    ).resolves.toBe(0);

    expect(repo.refreshUnknownRemoteState).not.toHaveBeenCalled();
    expect(repo.finalizePublished).not.toHaveBeenCalled();
    expect(repo.failUnknownRemoteState).not.toHaveBeenCalled();
    expect(repo.releaseReconciliationClaim).toHaveBeenCalledWith(claim);
  });

  it("isolates a provider failure and reconciles the next outcome", async () => {
    const second = { ...claim, id: "00000000-0000-4000-8000-000000000009" };
    const repo = repository();
    vi.mocked(repo.unknownRemoteOutcomes).mockResolvedValue([claim, second]);
    const onFailure = vi.fn();
    const provider = {
      platform: "YOUTUBE" as const,
      publish: vi.fn(),
      reconcile: vi
        .fn()
        .mockRejectedValueOnce(new Error("YOUTUBE_STATUS_FAILED_503"))
        .mockResolvedValueOnce({
          state: "PENDING",
          remoteStatus: "processing",
        } as const),
    };

    await expect(
      new ReconcilePublicationOutcomes(
        repo,
        [provider],
        undefined,
        onFailure,
      ).execute(),
    ).resolves.toBe(1);

    expect(onFailure).toHaveBeenCalledWith(claim.id, expect.any(Error));
    expect(repo.releaseReconciliationClaim).toHaveBeenCalledWith(claim);
    expect(repo.refreshUnknownRemoteState).toHaveBeenCalledWith(
      second,
      "processing",
      expect.any(Date),
    );
  });

  it("heartbeats later claims while they wait for sequential provider polling", async () => {
    vi.useFakeTimers();
    try {
      const second = { ...claim, id: "00000000-0000-4000-8000-000000000009" };
      const repo = repository();
      vi.mocked(repo.unknownRemoteOutcomes).mockResolvedValue([claim, second]);
      let finishFirst: (() => void) | undefined;
      const provider = {
        platform: "YOUTUBE" as const,
        publish: vi.fn(),
        reconcile: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<{ state: "PENDING"; remoteStatus: string }>(
                (resolve) => {
                  finishFirst = () =>
                    resolve({ state: "PENDING", remoteStatus: "processing" });
                },
              ),
          )
          .mockResolvedValueOnce({
            state: "PENDING" as const,
            remoteStatus: "processing",
          }),
      };

      const execution = new ReconcilePublicationOutcomes(repo, [
        provider,
      ]).execute();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(repo.heartbeatReconciliationClaim).toHaveBeenCalledWith(
        second,
        expect.any(Date),
      );
      expect(provider.reconcile).toHaveBeenCalledTimes(1);

      finishFirst?.();
      await expect(execution).resolves.toBe(2);
      expect(provider.reconcile).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts provider reconciliation and leaves cleanup to the new lease owner", async () => {
    vi.useFakeTimers();
    try {
      const repo = repository();
      vi.mocked(repo.heartbeatReconciliationClaim).mockResolvedValue(false);
      const release = vi.fn<(reason?: unknown) => void>();
      const provider = {
        platform: "YOUTUBE" as const,
        publish: vi.fn(),
        reconcile: vi.fn(
          (_claim: PublicationReconciliationClaim, signal?: AbortSignal) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                release(signal.reason);
                reject(signal.reason);
              });
            }),
        ),
      };

      const execution = new ReconcilePublicationOutcomes(repo, [
        provider,
      ]).execute();
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(execution).resolves.toBe(0);
      expect(release).toHaveBeenCalledOnce();
      expect(repo.releaseReconciliationClaim).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts reconciliation when heartbeat ownership cannot be proven", async () => {
    vi.useFakeTimers();
    try {
      const repo = repository();
      vi.mocked(repo.heartbeatReconciliationClaim).mockRejectedValue(
        new Error("database offline"),
      );
      const provider = {
        platform: "YOUTUBE" as const,
        publish: vi.fn(),
        reconcile: vi.fn(
          (_claim: PublicationReconciliationClaim, signal?: AbortSignal) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        ),
      };

      const execution = new ReconcilePublicationOutcomes(repo, [
        provider,
      ]).execute();
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(execution).resolves.toBe(0);
      expect(repo.refreshUnknownRemoteState).not.toHaveBeenCalled();
      expect(repo.releaseReconciliationClaim).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a hung reconciliation claim after its bounded deadline", async () => {
    vi.useFakeTimers();
    try {
      const repo = repository();
      const onFailure = vi.fn();
      const provider = {
        platform: "YOUTUBE" as const,
        publish: vi.fn(),
        reconcile: vi.fn(
          (_claim: PublicationReconciliationClaim, signal?: AbortSignal) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        ),
      };
      const execution = new ReconcilePublicationOutcomes(
        repo,
        [provider],
        undefined,
        onFailure,
        1_000,
      ).execute();

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(execution).resolves.toBe(0);
      expect(repo.releaseReconciliationClaim).toHaveBeenCalledWith(claim);
      expect(onFailure).toHaveBeenCalledWith(
        claim.id,
        expect.objectContaining({
          message: "PUBLICATION_RECONCILIATION_TIMEOUT",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report reconciliation after a fenced update loses the lease", async () => {
    const repo = repository();
    vi.mocked(repo.refreshUnknownRemoteState).mockResolvedValue(false);
    const provider = {
      platform: "YOUTUBE" as const,
      publish: vi.fn(),
      reconcile: vi
        .fn()
        .mockResolvedValue({ state: "PENDING", remoteStatus: "processing" }),
    };

    await expect(
      new ReconcilePublicationOutcomes(repo, [provider]).execute(),
    ).resolves.toBe(0);
  });
});
