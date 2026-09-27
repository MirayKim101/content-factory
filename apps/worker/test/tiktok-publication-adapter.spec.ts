import { describe, expect, it, vi } from "vitest";

import type { PublicationClaim } from "../src/application/publication.port.js";
import { PublicationOutcomeUnknownError } from "../src/application/publication.port.js";
import { PublicationSessionCipher } from "../src/infrastructure/publication-session-cipher.js";
import { TikTokPublicationAdapter } from "../src/infrastructure/tiktok-publication-adapter.js";

const claim: PublicationClaim = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  externalChannelRef: "723f24d7-e717-40f8-a2b6-cb8464cd23b4",
  platform: "TIKTOK",
  contentKind: "VERTICAL_RESULT",
  contentId: "00000000-0000-4000-8000-000000000003",
  contentObjectKey: "vertical/release.mp4",
  contentSizeBytes: 6n,
  contentSha256: "a".repeat(64),
  contentType: "video/mp4",
  metadataSnapshot: {
    title: "Release",
    privacyLevel: "SELF_ONLY",
    disableComment: false,
    disableDuet: true,
    disableStitch: false,
    brandContentToggle: false,
    brandOrganicToggle: false,
    consent: {
      version: "tiktok-direct-post-consent-v1",
      creatorUsername: "creator",
      creatorInfoFetchedAt: "2026-09-28T00:00:00.000Z",
      confirmedAt: "2026-09-28T00:01:00.000Z",
    },
  },
  attemptNumber: 1,
};

function dependencies() {
  return {
    tokens: { resolve: vi.fn().mockResolvedValue("access-token") },
    media: {
      verifyIdentity: vi.fn(),
      readRange: vi.fn().mockResolvedValue(Buffer.alloc(6)),
    },
    sessions: {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(true),
      advanceOffset: vi.fn().mockResolvedValue(true),
      remove: vi.fn(),
    },
    cipher: new PublicationSessionCipher(
      "v1",
      new Map([["v1", Buffer.alloc(32, 9)]]),
    ),
    transport: {
      creatorInfo: vi.fn().mockResolvedValue({
        creatorAvatarUrl: "https://example.test/avatar",
        creatorNickname: "Creator",
        creatorUsername: "creator",
        privacyLevelOptions: ["SELF_ONLY"],
        commentDisabled: false,
        duetDisabled: true,
        stitchDisabled: false,
        maxVideoPostDurationSec: 600,
      }),
      initiate: vi.fn().mockResolvedValue({
        publishId: "publish_42",
        uploadUrl: "https://open-upload.tiktokapis.com/video/?id=42",
        plan: { chunkSize: 6, totalChunkCount: 1 },
      }),
      uploadChunk: vi
        .fn()
        .mockResolvedValue({ complete: true, nextOffset: 6n }),
      status: vi.fn(),
      metrics: vi.fn(),
    },
  };
}

describe("TikTokPublicationAdapter", () => {
  it("persists the upload capability before transferring media and quarantines processing", async () => {
    const deps = dependencies();
    const adapter = new TikTokPublicationAdapter(
      deps.tokens,
      deps.media,
      deps.sessions,
      deps.cipher,
      deps.transport,
      () => new Date("2026-09-28T00:02:00.000Z"),
    );
    const controller = new AbortController();
    const error = await adapter
      .publish(claim, controller.signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PublicationOutcomeUnknownError);
    expect(error).toMatchObject({
      remotePublicationId: "publish_42",
      remoteStatus: "PROCESSING_UPLOAD",
    });
    expect(deps.sessions.save).toHaveBeenCalledBefore(
      deps.transport.uploadChunk,
    );
    expect(deps.sessions.save.mock.calls[0]![0].expiresAt).toBeNull();
    expect(deps.transport.creatorInfo).toHaveBeenCalledWith(
      "access-token",
      controller.signal,
    );
    expect(deps.transport.initiate).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(deps.transport.uploadChunk).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("rejects stale consent when current creator capabilities changed", async () => {
    const deps = dependencies();
    deps.transport.creatorInfo.mockResolvedValue({
      ...(await deps.transport.creatorInfo()),
      creatorUsername: "different-creator",
    });
    await expect(
      new TikTokPublicationAdapter(
        deps.tokens,
        deps.media,
        deps.sessions,
        deps.cipher,
        deps.transport,
      ).publish(claim),
    ).rejects.toThrow("TIKTOK_EXPLICIT_CONSENT_INVALID");
    expect(deps.transport.initiate).not.toHaveBeenCalled();
  });

  it("quarantines an ambiguous Direct Post initiation without retrying it", async () => {
    const deps = dependencies();
    deps.transport.initiate.mockRejectedValue(new TypeError("fetch failed"));
    const error = await new TikTokPublicationAdapter(
      deps.tokens,
      deps.media,
      deps.sessions,
      deps.cipher,
      deps.transport,
    )
      .publish(claim)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "PublicationOutcomeUnknownError",
      code: "TIKTOK_INITIATION_OUTCOME_UNKNOWN",
      remotePublicationId: null,
      remoteStatus: "initiation_outcome_unknown",
    });
    expect(deps.sessions.save).not.toHaveBeenCalled();
  });

  it("keeps deterministic initiation rejection retryable", async () => {
    const deps = dependencies();
    deps.transport.initiate.mockRejectedValue(
      new Error("TIKTOK_API_FAILED_429"),
    );
    await expect(
      new TikTokPublicationAdapter(
        deps.tokens,
        deps.media,
        deps.sessions,
        deps.cipher,
        deps.transport,
      ).publish(claim),
    ).rejects.toThrow("TIKTOK_API_FAILED_429");
  });

  it("retains the publish id when session persistence fails", async () => {
    const deps = dependencies();
    deps.sessions.save.mockRejectedValue(new Error("database unavailable"));
    const error = await new TikTokPublicationAdapter(
      deps.tokens,
      deps.media,
      deps.sessions,
      deps.cipher,
      deps.transport,
    )
      .publish(claim)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "PublicationOutcomeUnknownError",
      code: "TIKTOK_SESSION_PERSISTENCE_OUTCOME_UNKNOWN",
      remotePublicationId: "publish_42",
      remoteStatus: "PROCESSING_UPLOAD",
    });
    expect(deps.transport.uploadChunk).not.toHaveBeenCalled();
  });

  it("maps final provider status without posting again", async () => {
    const deps = dependencies();
    deps.transport.status.mockResolvedValue({
      status: "PUBLISH_COMPLETE",
      postIds: ["123"],
      uploadedBytes: 6n,
    });
    await expect(
      new TikTokPublicationAdapter(
        deps.tokens,
        deps.media,
        deps.sessions,
        deps.cipher,
        deps.transport,
      ).reconcile({
        ...claim,
        remotePublicationId: "publish_42",
        reconciliationLeaseToken: "lease-42",
      }),
    ).resolves.toMatchObject({
      state: "PUBLISHED",
      providerReceipt: { publishId: "publish_42", postIds: ["123"] },
    });
    expect(deps.transport.initiate).not.toHaveBeenCalled();
  });
});
