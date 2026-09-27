import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import { BullMqPublicationDispatch } from "../src/publishing/infrastructure/bullmq-publication-dispatch.js";

describe("BullMqPublicationDispatch", () => {
  it("uses a durable DB revision in the delivery id", async () => {
    const queue = {
      getJob: vi.fn(async () => undefined),
      add: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as Queue;
    const dispatch = new BullMqPublicationDispatch(queue);

    await dispatch.dispatch({
      id: "00000000-0000-4000-8000-000000000001",
      scheduledAt: new Date("2026-09-28T12:00:00.000Z"),
      deliveryRevision: "1790596801000",
    });

    const deliveryId = "00000000-0000-4000-8000-000000000001-1790596801000";
    expect(queue.getJob).toHaveBeenCalledWith(deliveryId);
    expect(queue.add).toHaveBeenCalledWith(
      "publication-v1",
      expect.objectContaining({
        publicationIntentId: "00000000-0000-4000-8000-000000000001",
      }),
      expect.objectContaining({ jobId: deliveryId, attempts: 1 }),
    );
  });

  it("deduplicates only the same durable revision", async () => {
    const queue = {
      getJob: vi.fn(async () => ({ id: "existing" })),
      add: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as Queue;

    await new BullMqPublicationDispatch(queue).dispatch({
      id: "00000000-0000-4000-8000-000000000001",
      scheduledAt: new Date(),
      deliveryRevision: "2",
    });

    expect(queue.add).not.toHaveBeenCalled();
  });
});
