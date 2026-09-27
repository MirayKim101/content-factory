import { describe, expect, it, vi } from "vitest";

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
  metadataSnapshot: { title: "Release" },
  attemptNumber: 1,
};

function repository(): PublicationWorkerRepository {
  return {
    claim: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null),
    finalizeDryRun: vi.fn(),
    failFinal: vi.fn(),
    markUnknownRemoteState: vi.fn(),
    unknownRemoteOutcomes: vi.fn().mockResolvedValue([]),
    refreshUnknownRemoteState: vi.fn(),
    finalizePublished: vi.fn(),
    failUnknownRemoteState: vi.fn(),
  };
}

describe("ProcessPublicationIntent", () => {
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
});
