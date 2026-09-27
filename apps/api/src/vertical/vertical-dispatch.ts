import {
  VERTICAL_JOB_SCHEMA_VERSION,
  VERTICAL_QUEUE_NAME,
  type VerticalJobReferenceV1,
} from "@content-factory/contracts";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";

import { apiEnvironment } from "../config/environment.js";

export const VERTICAL_DISPATCH = Symbol("VERTICAL_DISPATCH");
export interface VerticalDispatch {
  dispatch(jobId: string): Promise<void>;
}

@Injectable()
export class BullMqVerticalDispatch
  implements VerticalDispatch, OnModuleDestroy
{
  private readonly queue: Queue<VerticalJobReferenceV1> | null;

  constructor() {
    const config = apiEnvironment();
    this.queue = config.verticalRenderEnabled
      ? new Queue(VERTICAL_QUEUE_NAME, {
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

  async dispatch(jobId: string): Promise<void> {
    if (!this.queue || (await this.queue.getJob(jobId))) return;
    await this.queue.add(
      "vertical-render-v1",
      { schemaVersion: VERTICAL_JOB_SCHEMA_VERSION, jobId },
      {
        jobId,
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
