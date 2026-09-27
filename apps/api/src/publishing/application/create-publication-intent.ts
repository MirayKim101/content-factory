import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  requirePublicationSchedule,
  type PublicationPlatform,
} from "@content-factory/contracts";

import {
  PublicationScheduleInvalidError,
  PublishingUnavailableError,
  requirePublicationMetadata,
  requirePublicationTimezone,
} from "../domain/publication.js";
import {
  PUBLICATION_REPOSITORY,
  PUBLISHING_ADMISSION_ENABLED,
  type PublicationRepository,
} from "./publication-repository.port.js";

export interface CreatePublicationIntentInput {
  idempotencyKey: string;
  projectId: string;
  channelId: string;
  approvalId: string;
  exportResultId: string;
  platform: PublicationPlatform;
  scheduledAt: string;
  timezone: string;
  metadataSnapshot: unknown;
}

@Injectable()
export class CreatePublicationIntent {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
    @Inject(PUBLISHING_ADMISSION_ENABLED)
    private readonly admissionEnabled: boolean,
    @Optional()
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: CreatePublicationIntentInput) {
    if (!this.admissionEnabled) throw new PublishingUnavailableError();
    const timezone = requirePublicationTimezone(input.timezone);
    const metadataSnapshot = requirePublicationMetadata(
      input.metadataSnapshot,
    );
    let scheduledAt: Date;
    try {
      scheduledAt = new Date(
        requirePublicationSchedule(input.scheduledAt, this.clock()),
      );
    } catch {
      throw new PublicationScheduleInvalidError();
    }
    const canonical = {
      projectId: input.projectId,
      channelId: input.channelId,
      approvalId: input.approvalId,
      exportResultId: input.exportResultId,
      platform: input.platform,
      scheduledAt: scheduledAt.toISOString(),
      timezone,
      metadataSnapshot,
    };
    return this.repository.create({
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: createHash("sha256")
        .update(stableJson(canonical))
        .digest("hex"),
      ...canonical,
      scheduledAt,
    });
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
