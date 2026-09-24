import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";

import { apiEnvironment } from "../../config/environment.js";
import {
  RESEARCH_JOB_SCHEMA_VERSION,
  type ResearchSuggestionDeliveryV1,
  type ResearchSuggestionDispatch,
} from "../application/research-suggestion-dispatch.port.js";

export const RESEARCH_QUEUE = Symbol("RESEARCH_QUEUE");

export function createResearchQueue(): Queue<ResearchSuggestionDeliveryV1> | null {
  const config = apiEnvironment();
  if (config.mediaQueueDisabled) return null;
  return new Queue("ai-research-v1", {
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
export class BullMqResearchDispatch
  implements ResearchSuggestionDispatch, OnModuleDestroy
{
  constructor(
    @Inject(RESEARCH_QUEUE)
    private readonly queue: Queue<ResearchSuggestionDeliveryV1> | null,
  ) {}

  async dispatch(delivery: ResearchSuggestionDeliveryV1): Promise<void> {
    if (!this.queue) return;
    const existing = await this.queue.getJob(delivery.intentId);
    if (existing) {
      const state = await existing.getState();
      if (["waiting", "active", "delayed", "completed"].includes(state)) return;
      await existing.remove();
    }
    await this.queue.add(
      "research-suggestion-v1",
      { ...delivery, schemaVersion: RESEARCH_JOB_SCHEMA_VERSION },
      {
        jobId: delivery.intentId,
        attempts: 2,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
