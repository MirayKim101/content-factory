import { describe, expect, it, vi } from "vitest";

import { BoundedPublicationProvider } from "../src/application/bounded-publication-provider.js";
import type { PublicationClaim } from "../src/application/publication.port.js";
import { PublicationOutcomeUnknownError } from "../src/application/publication.port.js";

const claim = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  externalChannelRef: "UC1234567890123456789012",
  platform: "YOUTUBE",
  contentKind: "VERTICAL_RESULT",
  contentId: "00000000-0000-4000-8000-000000000003",
  contentObjectKey: "vertical/result.mp4",
  contentSizeBytes: 1024n,
  contentSha256: "a".repeat(64),
  contentType: "video/mp4",
  metadataSnapshot: { title: "Release" },
  attemptNumber: 1,
} satisfies PublicationClaim;

const result = {
  adapterVersion: "test-v1",
  providerReceipt: { id: "remote" },
  publicUrl: null,
};

describe("BoundedPublicationProvider", () => {
  it("serializes work for one platform without dropping queued calls", async () => {
    let finishFirst!: () => void;
    const publish = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof result>((resolve) => {
            finishFirst = () => resolve(result);
          }),
      )
      .mockResolvedValueOnce(result);
    const provider = new BoundedPublicationProvider(
      { platform: "YOUTUBE", publish },
      1,
    );

    const first = provider.publish(claim);
    const second = provider.publish({ ...claim, id: crypto.randomUUID() });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

    finishFirst();
    await expect(first).resolves.toEqual(result);
    await expect(second).resolves.toEqual(result);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("removes an aborted waiter without consuming the next permit", async () => {
    let finishFirst!: () => void;
    const publish = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof result>((resolve) => {
            finishFirst = () => resolve(result);
          }),
      )
      .mockResolvedValue(result);
    const provider = new BoundedPublicationProvider(
      { platform: "YOUTUBE", publish },
      1,
    );
    const first = provider.publish(claim);
    const controller = new AbortController();
    const aborted = provider.publish(
      { ...claim, id: crypto.randomUUID() },
      controller.signal,
    );
    const third = provider.publish({ ...claim, id: crypto.randomUUID() });
    controller.abort(new Error("LEASE_LOST"));

    await expect(aborted).rejects.toThrow("LEASE_LOST");
    finishFirst();
    await expect(first).resolves.toEqual(result);
    await expect(third).resolves.toEqual(result);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("does not advertise optional operations missing from the adapter", () => {
    const provider = new BoundedPublicationProvider(
      { platform: "YOUTUBE", publish: vi.fn() },
      1,
    );
    expect(provider.reconcile).toBeUndefined();
    expect(provider.metrics).toBeUndefined();
  });

  it("rejects invalid pool sizes", () => {
    expect(
      () =>
        new BoundedPublicationProvider(
          { platform: "YOUTUBE", publish: vi.fn() },
          0,
        ),
    ).toThrow("PUBLICATION_PROVIDER_CONCURRENCY_INVALID");
  });

  it("opens after bounded transient failures and probes again after cooldown", async () => {
    let now = 1_000;
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("YOUTUBE_UPLOAD_FAILED_503"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(result);
    const provider = new BoundedPublicationProvider(
      { platform: "YOUTUBE", publish },
      1,
      { failureThreshold: 2, cooldownMs: 5_000, clock: () => now },
    );

    await expect(provider.publish(claim)).rejects.toThrow("503");
    await expect(provider.publish(claim)).rejects.toThrow("fetch failed");
    await expect(provider.publish(claim)).rejects.toThrow(
      "PUBLICATION_PROVIDER_CIRCUIT_OPEN",
    );
    expect(publish).toHaveBeenCalledTimes(2);

    now += 5_000;
    await expect(provider.publish(claim)).resolves.toEqual(result);
    expect(publish).toHaveBeenCalledTimes(3);
    await expect(provider.publish(claim)).resolves.toEqual(result);
  });

  it("does not open for deterministic validation failures", async () => {
    const publish = vi
      .fn()
      .mockRejectedValue(new Error("TIKTOK_EXPLICIT_CONSENT_INVALID"));
    const provider = new BoundedPublicationProvider(
      { platform: "TIKTOK", publish },
      1,
      { failureThreshold: 1, cooldownMs: 5_000 },
    );

    await expect(
      provider.publish({ ...claim, platform: "TIKTOK" }),
    ).rejects.toThrow("TIKTOK_EXPLICIT_CONSENT_INVALID");
    await expect(
      provider.publish({ ...claim, platform: "TIKTOK" }),
    ).rejects.toThrow("TIKTOK_EXPLICIT_CONSENT_INVALID");
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("does not treat a durable unknown-remote handoff as provider downtime", async () => {
    const publish = vi
      .fn()
      .mockRejectedValue(
        new PublicationOutcomeUnknownError(
          "TIKTOK_PUBLICATION_PROCESSING",
          "TikTok accepted the upload.",
          "publish-id",
          "PROCESSING_UPLOAD",
        ),
      );
    const provider = new BoundedPublicationProvider(
      { platform: "TIKTOK", publish },
      1,
      { failureThreshold: 1, cooldownMs: 5_000 },
    );

    await expect(
      provider.publish({ ...claim, platform: "TIKTOK" }),
    ).rejects.toBeInstanceOf(PublicationOutcomeUnknownError);
    await expect(
      provider.publish({ ...claim, platform: "TIKTOK" }),
    ).rejects.toBeInstanceOf(PublicationOutcomeUnknownError);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid circuit configuration", () => {
    expect(
      () =>
        new BoundedPublicationProvider(
          { platform: "YOUTUBE", publish: vi.fn() },
          1,
          { failureThreshold: 0, cooldownMs: 1 },
        ),
    ).toThrow("PUBLICATION_PROVIDER_CIRCUIT_INVALID");
  });
});
