import {
  MEDIA_JOB_SCHEMA_VERSION,
  type MediaJobReferenceV1,
} from "@content-factory/contracts";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";

import { apiEnvironment } from "../../config/environment.js";
import type {
  JobDelivery,
  JobDispatch,
} from "../application/job-dispatch.port.js";
import {
  PIPELINE_REPOSITORY,
  type PipelineRepository,
} from "../application/pipeline-repository.port.js";

export const MEDIA_QUEUE = Symbol("MEDIA_QUEUE");

export function createMediaQueue(): Queue<MediaJobReferenceV1> | null {
  const config = apiEnvironment();
  if (config.mediaQueueDisabled) return null;
  return new Queue(config.mediaQueueName, {
    connection: {
      host: config.redisHost,
      port: config.redisPort,
      password: config.redisPassword,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    },
  });
}

@Injectable()
export class BullMqJobDispatch implements JobDispatch, OnModuleDestroy {
  constructor(
    @Inject(MEDIA_QUEUE)
    private readonly queue: Queue<MediaJobReferenceV1> | null,
    @Inject(PIPELINE_REPOSITORY)
    private readonly repository: PipelineRepository,
  ) {}

  async dispatch(delivery: JobDelivery): Promise<void> {
    if (!this.queue) return;
    if (!(await this.repository.isDeliveryRunnable(delivery))) return;
    const deliveryId = `${delivery.jobId}-attempt-${delivery.attemptNumber}`;
    const existing = await this.queue.getJob(deliveryId);
    if (existing) {
      const state = await existing.getState();
      if (state === "failed" || state === "completed") {
        if (!(await this.repository.isDeliveryRunnable(delivery))) return;
        await existing.remove();
      } else {
        return;
      }
    }
    if (!(await this.repository.isDeliveryRunnable(delivery))) return;
    await this.queue.add(
      "media-job-v1",
      { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, jobId: delivery.jobId },
      {
        jobId: deliveryId,
        attempts: 1,
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
