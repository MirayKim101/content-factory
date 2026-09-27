import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  requirePublicationSchedule,
  type PublicationContentKind,
  type PublicationPlatform,
} from "@content-factory/contracts";

import {
  PublicationLineageInvalidError,
  PublicationScheduleInvalidError,
  PublishingUnavailableError,
  requirePublicationMetadata,
  requireTikTokPublicationMetadata,
  requirePublicationTimezone,
} from "../domain/publication.js";
import {
  PUBLICATION_REPOSITORY,
  PUBLISHING_ADMISSION_ENABLED,
  TIKTOK_PUBLISHING_ADMISSION_ENABLED,
  YOUTUBE_PUBLISHING_ADMISSION_ENABLED,
  type PublicationRepository,
} from "./publication-repository.port.js";
import {
  PUBLICATION_DISPATCH,
  type PublicationDispatch,
} from "./publication-dispatch.port.js";

export interface CreatePublicationIntentInput {
  idempotencyKey: string;
  projectId: string;
  channelId: string;
  contentKind?: PublicationContentKind;
  approvalId?: string;
  exportResultId?: string;
  verticalApprovalId?: string;
  verticalResultId?: string;
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
    @Inject(YOUTUBE_PUBLISHING_ADMISSION_ENABLED)
    private readonly youtubeAdmissionEnabled: boolean,
    @Inject(TIKTOK_PUBLISHING_ADMISSION_ENABLED)
    private readonly tiktokAdmissionEnabled: boolean,
    @Inject(PUBLICATION_DISPATCH)
    private readonly dispatch: PublicationDispatch,
    @Optional()
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: CreatePublicationIntentInput) {
    if (!this.admissionEnabled) throw new PublishingUnavailableError();
    if (
      input.platform !== "LOCAL_DRY_RUN" &&
      !(input.platform === "YOUTUBE" && this.youtubeAdmissionEnabled) &&
      !(input.platform === "TIKTOK" && this.tiktokAdmissionEnabled)
    )
      throw new PublishingUnavailableError();
    if (
      input.platform !== "LOCAL_DRY_RUN" &&
      (input.contentKind ?? "EDITORIAL_EXPORT") !== "VERTICAL_RESULT"
    )
      throw new PublicationLineageInvalidError();
    const timezone = requirePublicationTimezone(input.timezone);
    const metadataSnapshot = requirePublicationMetadata(input.metadataSnapshot);
    if (input.platform === "TIKTOK")
      requireTikTokPublicationMetadata(metadataSnapshot, this.clock());
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
      contentKind: input.contentKind ?? "EDITORIAL_EXPORT",
      approvalId: input.approvalId,
      exportResultId: input.exportResultId,
      verticalApprovalId: input.verticalApprovalId,
      verticalResultId: input.verticalResultId,
      platform: input.platform,
      scheduledAt: scheduledAt.toISOString(),
      timezone,
      metadataSnapshot,
    };
    const intent = await this.repository.create({
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: createHash("sha256")
        .update(stableJson(canonical))
        .digest("hex"),
      ...canonical,
      scheduledAt,
    });
    await Promise.allSettled([
      this.dispatch.dispatch({
        id: intent.id,
        scheduledAt: intent.scheduledAt,
      }),
    ]);
    return intent;
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
