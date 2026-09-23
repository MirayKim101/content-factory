import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { apiEnvironment } from "../../config/environment.js";
import {
  TRANSCRIPT_EVIDENCE_DISPATCH,
  TRANSCRIPT_JOB_SCHEMA_VERSION,
  type TranscriptEvidenceDeliveryV1,
  type TranscriptEvidenceDispatch,
} from "../application/transcript-evidence-dispatch.port.js";

export const TRANSCRIPT_QUEUE = Symbol("TRANSCRIPT_QUEUE");

export function createTranscriptQueue(): Queue<TranscriptEvidenceDeliveryV1> | null {
  const config = apiEnvironment();
  if (config.mediaQueueDisabled) return null;
  return new Queue("ai-transcript-v1", {
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
export class BullMqTranscriptDispatch
  implements TranscriptEvidenceDispatch, OnModuleDestroy
{
  constructor(
    @Inject(TRANSCRIPT_QUEUE)
    private readonly queue: Queue<TranscriptEvidenceDeliveryV1> | null,
  ) {}

  async dispatch(delivery: TranscriptEvidenceDeliveryV1): Promise<void> {
    if (!this.queue) return;
    const existing = await this.queue.getJob(delivery.intentId);
    if (existing) {
      const state = await existing.getState();
      if (["waiting", "active", "delayed", "completed"].includes(state)) return;
      await existing.remove();
    }
    await this.queue.add(
      "transcript-evidence-v1",
      { ...delivery, schemaVersion: TRANSCRIPT_JOB_SCHEMA_VERSION },
      {
        jobId: delivery.intentId,
        attempts: 3,
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
