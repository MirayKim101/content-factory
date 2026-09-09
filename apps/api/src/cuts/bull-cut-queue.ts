import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { CutQueuePublisher } from "@content-factory/manual-cut";

import { apiEnvironment } from "../config/environment.js";

export const CUT_QUEUE_NAME = "content-factory-media-v1";

@Injectable()
export class BullCutQueue implements CutQueuePublisher, OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<{ jobId: string }>;

  constructor() {
    const config = apiEnvironment();
    this.connection = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      ...(config.redisPassword ? { password: config.redisPassword } : {}),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: config.cutQueuePublishTimeoutMs,
      protocol: 2,
      lazyConnect: true,
    });
    this.connection.on("error", () => undefined);
    this.queue = new Queue(CUT_QUEUE_NAME, { connection: this.connection });
  }

  async publish(jobId: string): Promise<void> {
    await this.queue.add(
      "manual-cut-job-v1",
      { jobId },
      {
        jobId,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
