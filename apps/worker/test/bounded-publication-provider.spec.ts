import { describe, expect, it, vi } from "vitest";

import { BoundedPublicationProvider } from "../src/application/bounded-publication-provider.js";
import type { PublicationClaim } from "../src/application/publication.port.js";

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
});
