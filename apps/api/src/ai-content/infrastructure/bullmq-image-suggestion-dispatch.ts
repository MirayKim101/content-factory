import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";

import { apiEnvironment } from "../../config/environment.js";
import {
  IMAGE_SUGGESTION_JOB_SCHEMA_VERSION,
  type ImageSuggestionDispatch,
} from "../application/image-suggestion-dispatch.port.js";

export const IMAGE_SUGGESTION_QUEUE = Symbol("IMAGE_SUGGESTION_QUEUE");

export function createImageSuggestionQueue(): Queue | null {
  const config = apiEnvironment();
  if (config.mediaQueueDisabled) return null;
  return new Queue("ai-image-suggestion-v1", {
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
export class BullMqImageSuggestionDispatch
  implements ImageSuggestionDispatch, OnModuleDestroy
{
  constructor(
    @Inject(IMAGE_SUGGESTION_QUEUE) private readonly queue: Queue | null,
  ) {}

  async dispatch(input: {
    schemaVersion: typeof IMAGE_SUGGESTION_JOB_SCHEMA_VERSION;
    intentId: string;
  }): Promise<void> {
    if (!this.queue) return;
    await this.queue.add("generate", input, {
      jobId: input.intentId,
      removeOnComplete: 500,
      removeOnFail: 500,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
