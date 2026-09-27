import {
  PUBLICATION_JOB_SCHEMA_VERSION,
  PUBLICATION_QUEUE_NAME,
  type PublicationJobReferenceV1,
} from "@content-factory/contracts";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";

import { apiEnvironment } from "../../config/environment.js";
import type { PublicationDispatch } from "../application/publication-dispatch.port.js";

@Injectable()
export class BullMqPublicationDispatch
  implements PublicationDispatch, OnModuleDestroy
{
  private readonly queue: Queue<PublicationJobReferenceV1> | null;

  constructor() {
    const config = apiEnvironment();
    this.queue = config.publishingEnabled
      ? new Queue(PUBLICATION_QUEUE_NAME, {
          connection: {
            host: config.redisHost,
            port: config.redisPort,
            password: config.redisPassword,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            lazyConnect: true,
          },
        })
      : null;
  }

  async dispatch(input: { id: string; scheduledAt: Date }): Promise<void> {
    if (!this.queue) return;
    const existing = await this.queue.getJob(input.id);
    if (existing) return;
    await this.queue.add(
      "publication-v1",
      {
        schemaVersion: PUBLICATION_JOB_SCHEMA_VERSION,
        publicationIntentId: input.id,
      },
      {
        jobId: input.id,
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
