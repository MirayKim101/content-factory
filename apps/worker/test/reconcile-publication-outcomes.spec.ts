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
  metadataSnapshot: { title: "Release" },
  attemptNumber: 1,
  remotePublicationId: "youtube-video-42",
};

function repository(): PublicationWorkerRepository {
  return {
    claim: vi.fn(),
    finalizeDryRun: vi.fn(),
    failFinal: vi.fn(),
    markUnknownRemoteState: vi.fn(),
    unknownRemoteOutcomes: vi.fn().mockResolvedValue([claim]),
    refreshUnknownRemoteState: vi.fn(),
    finalizePublished: vi.fn(),
    failUnknownRemoteState: vi.fn(),
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
  });
});
