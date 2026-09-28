import { describe, expect, it, vi } from "vitest";

import type { PublicationClaim } from "../src/application/publication.port.js";
import { PublicationSessionCipher } from "../src/infrastructure/publication-session-cipher.js";
import { YoutubePublicationAdapter } from "../src/infrastructure/youtube-publication-adapter.js";

const claim: PublicationClaim = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  externalChannelRef: "channel-42",
  platform: "YOUTUBE",
  contentKind: "VERTICAL_RESULT",
  contentId: "00000000-0000-4000-8000-000000000003",
  contentObjectKey: "vertical/release.mp4",
  contentSizeBytes: 6n,
  contentSha256: "a".repeat(64),
  contentType: "video/mp4",
  metadataSnapshot: { title: "Release", privacyStatus: "private" },
  attemptNumber: 1,
};

function dependencies() {
  const cipher = new PublicationSessionCipher(
    "v1",
    new Map([["v1", Buffer.alloc(32, 7)]]),
  );
  return {
    cipher,
    tokens: { resolve: vi.fn().mockResolvedValue("access-token") },
    media: {
      verifyIdentity: vi.fn(),
      readRange: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from("abc"))
        .mockResolvedValueOnce(Buffer.from("def")),
    },
    sessions: {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(true),
      advanceOffset: vi.fn().mockResolvedValue(true),
      remove: vi.fn(),
    },
    transport: {
      initiate: vi
        .fn()
        .mockResolvedValue("https://www.googleapis.com/upload/session"),
      probe: vi.fn(),
      status: vi.fn(),
      metrics: vi.fn(),
      uploadChunk: vi
        .fn()
        .mockResolvedValueOnce({ state: "INCOMPLETE", nextOffset: 3n })
        .mockResolvedValueOnce({ state: "COMPLETE", videoId: "video_42" }),
    },
  };
}

describe("YoutubePublicationAdapter", () => {
  it("rejects non-vertical or non-MP4 content before reading credentials or media", async () => {
    const deps = dependencies();
    const adapter = new YoutubePublicationAdapter(
      deps.tokens,
      deps.media,
      deps.sessions,
      deps.cipher,
      deps.transport,
    );

    await expect(
      adapter.publish({
        ...claim,
        contentKind: "EDITORIAL_EXPORT",
        contentType: "application/zip",
      }),
    ).rejects.toMatchObject({
      name: "PublicationPermanentError",
      code: "YOUTUBE_CONTENT_KIND_INVALID",
    });
    await expect(
      adapter.publish({ ...claim, contentType: "video/webm" }),
    ).rejects.toMatchObject({
      name: "PublicationPermanentError",
      code: "YOUTUBE_CONTENT_TYPE_INVALID",
    });
    expect(deps.tokens.resolve).not.toHaveBeenCalled();
    expect(deps.media.verifyIdentity).not.toHaveBeenCalled();
  });

  it("persists the capability before uploading verified chunks", async () => {
    const deps = dependencies();
    const adapter = new YoutubePublicationAdapter(
      deps.tokens,
      deps.media,
      deps.sessions,
      deps.cipher,
      deps.transport,
      256 * 1024,
    );

    const controller = new AbortController();
    await expect(adapter.publish(claim, controller.signal)).resolves.toEqual({
      adapterVersion: "youtube-resumable-v1",
      providerReceipt: { videoId: "video_42", mediaSha256: "a".repeat(64) },
      publicUrl: "https://www.youtube.com/watch?v=video_42",
    });

    expect(deps.sessions.save).toHaveBeenCalledBefore(
      deps.transport.uploadChunk,
    );
    const saved = deps.sessions.save.mock.calls[0]![0];
    expect(saved).not.toHaveProperty("sessionUrl");
    expect(saved.ciphertext.toString()).not.toContain("googleapis.com");
    expect(deps.sessions.advanceOffset).toHaveBeenCalledWith(
      expect.objectContaining({ expectedOffset: 0n, nextOffset: 3n }),
    );
    expect(deps.transport.initiate).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(deps.transport.uploadChunk).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(deps.media.readRange).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("classifies invalid metadata as a permanent preflight failure", async () => {
    const deps = dependencies();

    await expect(
      new YoutubePublicationAdapter(
        deps.tokens,
        deps.media,
        deps.sessions,
        deps.cipher,
        deps.transport,
      ).publish({ ...claim, metadataSnapshot: { title: "" } }),
    ).rejects.toMatchObject({
      name: "PublicationPermanentError",
      code: "YOUTUBE_TITLE_INVALID",
    });
    expect(deps.transport.initiate).not.toHaveBeenCalled();
    expect(deps.transport.uploadChunk).not.toHaveBeenCalled();
  });

  it("probes and resumes an encrypted prior session without initiating again", async () => {
    const deps = dependencies();
    const encrypted = deps.cipher.encrypt({
      publicationIntentId: claim.id,
      platform: claim.platform,
      session: {
        kind: "youtube-resumable-v1",
        sessionUrl: "https://www.googleapis.com/upload/session",
      },
    });
    deps.sessions.load.mockResolvedValue({
      publicationIntentId: claim.id,
      platform: claim.platform,
      ...encrypted,
      uploadOffset: 0n,
      expiresAt: null,
    });
    deps.transport.probe.mockResolvedValue({
      state: "INCOMPLETE",
      nextOffset: 3n,
    });
    deps.transport.uploadChunk.mockReset().mockResolvedValue({
      state: "COMPLETE",
      videoId: "video_42",
    });

    await new YoutubePublicationAdapter(
      deps.tokens,
      deps.media,
      deps.sessions,
      deps.cipher,
      deps.transport,
      256 * 1024,
    ).publish(claim);

    expect(deps.transport.initiate).not.toHaveBeenCalled();
    expect(deps.media.readRange).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 3n, length: 3 }),
    );
  });

  it("reconciles a processed remote video without uploading it again", async () => {
    const deps = dependencies();
    deps.transport.status.mockResolvedValue("processed");
    const adapter = new YoutubePublicationAdapter(
      deps.tokens,
      deps.media,
      deps.sessions,
      deps.cipher,
      deps.transport,
    );

    await expect(
      adapter.reconcile({
        ...claim,
        remotePublicationId: "video_42",
        reconciliationLeaseToken: "lease-42",
      }),
    ).resolves.toMatchObject({
      state: "PUBLISHED",
      remoteStatus: "processed",
      providerReceipt: { videoId: "video_42" },
    });
    expect(deps.transport.uploadChunk).not.toHaveBeenCalled();
  });
});
