import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessPublicationIntent } from "../src/application/process-publication-intent.js";
import type {
  PublicationClaim,
  PublicationWorkerRepository,
} from "../src/application/publication.port.js";
import { PublicationOutcomeUnknownError } from "../src/application/publication.port.js";
import {
  LOCAL_DRY_RUN_PUBLICATION_ADAPTER_VERSION,
  LocalDryRunPublicationAdapter,
} from "../src/infrastructure/local-dry-run-publication-adapter.js";

const claim: PublicationClaim = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000003",
  externalChannelRef: "local:test-channel",
  platform: "LOCAL_DRY_RUN",
  contentKind: "EDITORIAL_EXPORT",
  contentId: "00000000-0000-4000-8000-000000000002",
  contentObjectKey: "exports/release.zip",
  contentSizeBytes: 1024n,
  contentSha256: "a".repeat(64),
  contentType: "application/zip",
  metadataSnapshot: { title: "Release" },
  attemptNumber: 1,
};

function repository(): PublicationWorkerRepository {
  return {
    claim: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(true),
    finalizeDryRun: vi.fn(),
    finalizePublishedDirect: vi.fn(),
    releaseForRetry: vi.fn(),
    failFinal: vi.fn(),
    markUnknownRemoteState: vi.fn(),
    unknownRemoteOutcomes: vi.fn().mockResolvedValue([]),
    refreshUnknownRemoteState: vi.fn(),
    finalizePublished: vi.fn(),
    failUnknownRemoteState: vi.fn(),
  };
}

afterEach(() => vi.useRealTimers());

describe("ProcessPublicationIntent", () => {
  it("heartbeats a long-running publication claim until provider work settles", async () => {
    vi.useFakeTimers();
    const repo = repository();
    let complete!: (value: {
      adapterVersion: string;
      providerReceipt: Record<string, unknown>;
      publicUrl: null;
    }) => void;
    const publish = vi.fn(
      () =>
        new Promise<{
          adapterVersion: string;
          providerReceipt: Record<string, unknown>;
          publicUrl: null;
        }>((resolve) => {
          complete = resolve;
        }),
    );
    const processing = new ProcessPublicationIntent(repo, [
      { platform: "LOCAL_DRY_RUN", publish },
    ]).execute(claim.id);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(repo.heartbeat).toHaveBeenCalledWith(claim, expect.any(Date));
    complete({
      adapterVersion: "local-test-v1",
      providerReceipt: { externalWritePerformed: false },
      publicUrl: null,
    });
    await expect(processing).resolves.toBe(true);

    vi.mocked(repo.heartbeat).mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(repo.heartbeat).not.toHaveBeenCalled();
  });

  it("aborts provider work when the publication lease is lost", async () => {
    vi.useFakeTimers();
    const repo = repository();
    vi.mocked(repo.heartbeat).mockResolvedValue(false);
    const publish = vi.fn(
      (_claim: PublicationClaim, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const processing = new ProcessPublicationIntent(repo, [
      { platform: "LOCAL_DRY_RUN", publish },
    ]).execute(claim.id);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(processing).resolves.toBe(false);
    expect(repo.finalizeDryRun).not.toHaveBeenCalled();
    expect(repo.finalizePublishedDirect).not.toHaveBeenCalled();
    expect(repo.releaseForRetry).not.toHaveBeenCalled();
    expect(repo.failFinal).not.toHaveBeenCalled();
  });

  it("turns duplicate delivery into one durable dry-run result", async () => {
    const repo = repository();
    const process = new ProcessPublicationIntent(
      repo,
      [new LocalDryRunPublicationAdapter()],
      () => new Date("2026-10-01T09:00:00.000Z"),
    );
    await expect(process.execute(claim.id)).resolves.toBe(true);
    await expect(process.execute(claim.id)).resolves.toBe(false);
    expect(repo.finalizeDryRun).toHaveBeenCalledTimes(1);
    expect(repo.finalizeDryRun).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({
        adapterVersion: LOCAL_DRY_RUN_PUBLICATION_ADAPTER_VERSION,
        providerReceipt: expect.objectContaining({
          externalWritePerformed: false,
        }),
        publicUrl: null,
      }),
      new Date("2026-10-01T09:00:00.000Z"),
    );
  });

  it("fails closed when no provider is admitted", async () => {
    const repo = repository();
    const process = new ProcessPublicationIntent(repo, []);
    await expect(process.execute(claim.id)).resolves.toBe(true);
    expect(repo.failFinal).toHaveBeenCalledWith(
      claim,
      "PUBLICATION_PROVIDER_UNAVAILABLE",
      expect.any(String),
      expect.any(Date),
    );
  });

  it("quarantines an ambiguous remote outcome without retrying the POST", async () => {
    const remoteClaim = { ...claim, platform: "YOUTUBE" as const };
    const repo = repository();
    vi.mocked(repo.claim).mockReset().mockResolvedValueOnce(remoteClaim);
    const provider = {
      platform: "YOUTUBE" as const,
      publish: vi
        .fn()
        .mockRejectedValue(
          new PublicationOutcomeUnknownError(
            "YOUTUBE_UPLOAD_TIMEOUT",
            "Timed out after the provider accepted the upload.",
            "youtube-video-42",
            "processing",
          ),
        ),
    };
    const process = new ProcessPublicationIntent(repo, [provider]);

    await expect(process.execute(remoteClaim.id)).resolves.toBe(true);

    expect(repo.markUnknownRemoteState).toHaveBeenCalledWith(
      remoteClaim,
      "YOUTUBE_UPLOAD_TIMEOUT",
      expect.any(String),
      "youtube-video-42",
      "processing",
      expect.any(Date),
    );
    expect(repo.failFinal).not.toHaveBeenCalled();
    expect(provider.publish).toHaveBeenCalledOnce();
  });

  it("finalizes a confirmed external upload directly", async () => {
    const remoteClaim = { ...claim, platform: "YOUTUBE" as const };
    const repo = repository();
    vi.mocked(repo.claim).mockReset().mockResolvedValueOnce(remoteClaim);
    const result = {
      adapterVersion: "youtube-resumable-v1",
      providerReceipt: { videoId: "video_42" },
      publicUrl: "https://www.youtube.com/watch?v=video_42",
    };

    await new ProcessPublicationIntent(repo, [
      {
        platform: "YOUTUBE",
        publish: vi.fn().mockResolvedValue(result),
      },
    ]).execute(remoteClaim.id);

    expect(repo.finalizePublishedDirect).toHaveBeenCalledWith(
      remoteClaim,
      result,
      expect.any(Date),
    );
    expect(repo.finalizeDryRun).not.toHaveBeenCalled();
  });

  it("releases a resumable external failure into the bounded retry path", async () => {
    const remoteClaim = { ...claim, platform: "YOUTUBE" as const };
    const repo = repository();
    vi.mocked(repo.claim).mockReset().mockResolvedValueOnce(remoteClaim);

    await new ProcessPublicationIntent(repo, [
      {
        platform: "YOUTUBE",
        publish: vi
          .fn()
          .mockRejectedValue(new Error("YOUTUBE_UPLOAD_FAILED_503")),
      },
    ]).execute(remoteClaim.id);

    expect(repo.releaseForRetry).toHaveBeenCalledWith(
      remoteClaim,
      "PUBLICATION_PROVIDER_ATTEMPT_FAILED",
      "YOUTUBE_UPLOAD_FAILED_503",
      expect.any(Date),
    );
    expect(repo.failFinal).not.toHaveBeenCalled();
  });

  it("quarantines a confirmed remote upload when local finalization fails", async () => {
    const remoteClaim = { ...claim, platform: "YOUTUBE" as const };
    const repo = repository();
    vi.mocked(repo.claim).mockReset().mockResolvedValueOnce(remoteClaim);
    vi.mocked(repo.finalizePublishedDirect).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await new ProcessPublicationIntent(repo, [
      {
        platform: "YOUTUBE",
        publish: vi.fn().mockResolvedValue({
          adapterVersion: "youtube-resumable-v1",
          providerReceipt: { videoId: "video_42" },
          publicUrl: "https://www.youtube.com/watch?v=video_42",
        }),
      },
    ]).execute(remoteClaim.id);

    expect(repo.markUnknownRemoteState).toHaveBeenCalledWith(
      remoteClaim,
      "PUBLICATION_FINALIZE_OUTCOME_UNKNOWN",
      expect.any(String),
      "video_42",
      "provider_confirmed",
      expect.any(Date),
    );
    expect(repo.releaseForRetry).not.toHaveBeenCalled();
  });

  it("never retries a provider-confirmed write when its receipt has no usable remote id", async () => {
    const remoteClaim = { ...claim, platform: "YOUTUBE" as const };
    const repo = repository();
    vi.mocked(repo.claim).mockReset().mockResolvedValueOnce(remoteClaim);
    vi.mocked(repo.finalizePublishedDirect).mockRejectedValueOnce(
      new Error("PUBLICATION_PROVIDER_RECEIPT_INVALID"),
    );

    await new ProcessPublicationIntent(repo, [
      {
        platform: "YOUTUBE",
        publish: vi.fn().mockResolvedValue({
          adapterVersion: "youtube-resumable-v1",
          providerReceipt: { status: "accepted" },
          publicUrl: null,
        }),
      },
    ]).execute(remoteClaim.id);

    expect(repo.markUnknownRemoteState).toHaveBeenCalledWith(
      remoteClaim,
      "PUBLICATION_FINALIZE_OUTCOME_UNKNOWN",
      expect.any(String),
      null,
      "provider_confirmed",
      expect.any(Date),
    );
    expect(repo.releaseForRetry).not.toHaveBeenCalled();
  });

  it("never releases a confirmed external write when quarantine persistence also fails", async () => {
    const remoteClaim = { ...claim, platform: "YOUTUBE" as const };
    const repo = repository();
    vi.mocked(repo.claim).mockReset().mockResolvedValueOnce(remoteClaim);
    vi.mocked(repo.finalizePublishedDirect).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    vi.mocked(repo.markUnknownRemoteState).mockRejectedValueOnce(
      new Error("database still unavailable"),
    );

    await expect(
      new ProcessPublicationIntent(repo, [
        {
          platform: "YOUTUBE",
          publish: vi.fn().mockResolvedValue({
            adapterVersion: "youtube-resumable-v1",
            providerReceipt: { videoId: "video_42" },
            publicUrl: null,
          }),
        },
      ]).execute(remoteClaim.id),
    ).rejects.toThrow("database still unavailable");
    expect(repo.releaseForRetry).not.toHaveBeenCalled();
  });
});
