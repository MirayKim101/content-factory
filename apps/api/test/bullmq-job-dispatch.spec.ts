import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { PipelineRepository } from "../src/media-pipeline/application/pipeline-repository.port.js";
import { BullMqJobDispatch } from "../src/media-pipeline/infrastructure/bullmq-job-dispatch.js";

describe("BullMqJobDispatch coordination collisions", () => {
  it.each(["completed", "failed"])(
    "replaces a %s delivery only while the exact DB attempt is runnable",
    async (state) => {
      const remove = vi.fn(async () => undefined);
      const queue = {
        getJob: vi.fn(async () => ({
          getState: vi.fn(async () => state),
          remove,
        })),
        add: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as unknown as Queue;
      const repository = {
        isDeliveryRunnable: vi.fn(async () => true),
      } as unknown as PipelineRepository;
      const dispatch = new BullMqJobDispatch(queue, repository);
      const delivery = {
        jobId: "00000000-0000-4000-8000-000000000001",
        attemptNumber: 2,
      };

      await dispatch.dispatch(delivery);

      expect(remove).toHaveBeenCalledOnce();
      expect(queue.add).toHaveBeenCalledWith(
        "media-job-v1",
        expect.objectContaining({ jobId: delivery.jobId }),
        expect.objectContaining({
          jobId: `${delivery.jobId}-attempt-2`,
          attempts: 1,
        }),
      );
    },
  );

  it("does not touch a completed delivery after PostgreSQL becomes non-runnable", async () => {
    const queue = {
      getJob: vi.fn(),
      add: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as Queue;
    const repository = {
      isDeliveryRunnable: vi.fn(async () => false),
    } as unknown as PipelineRepository;

    await new BullMqJobDispatch(queue, repository).dispatch({
      jobId: "00000000-0000-4000-8000-000000000001",
      attemptNumber: 2,
    });

    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
