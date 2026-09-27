import {
  PUBLICATION_JOB_SCHEMA_VERSION,
  PUBLICATION_QUEUE_NAME,
  type PublicationJobReferenceV1,
} from "@content-factory/contracts";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";

import { apiEnvironment } from "../../config/environment.js";
import type { PublicationDispatch } from "../application/publication-dispatch.port.js";

export const PUBLICATION_QUEUE = Symbol("PUBLICATION_QUEUE");

export function createPublicationQueue(): Queue<PublicationJobReferenceV1> | null {
  const config = apiEnvironment();
  if (!config.publishingEnabled) return null;
  return new Queue(PUBLICATION_QUEUE_NAME, {
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
export class BullMqPublicationDispatch
  implements PublicationDispatch, OnModuleDestroy
{
  constructor(
    @Inject(PUBLICATION_QUEUE)
    private readonly queue: Queue<PublicationJobReferenceV1> | null,
  ) {}

  async dispatch(input: {
    id: string;
    scheduledAt: Date;
    deliveryRevision: string;
  }): Promise<void> {
    if (!this.queue) return;
    const deliveryId = `${input.id}-${input.deliveryRevision}`;
    const existing = await this.queue.getJob(deliveryId);
    if (existing) return;
    await this.queue.add(
      "publication-v1",
      {
        schemaVersion: PUBLICATION_JOB_SCHEMA_VERSION,
        publicationIntentId: input.id,
      },
      {
        jobId: deliveryId,
        delay: Math.max(0, input.scheduledAt.getTime() - Date.now()),
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
