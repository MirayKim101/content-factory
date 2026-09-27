import type { PublicationPlatform } from "@content-factory/contracts";

import type {
  PublicationChannelView,
  PublicationIntentView,
} from "../domain/publication.js";

export const PUBLICATION_REPOSITORY = Symbol("PUBLICATION_REPOSITORY");
export const PUBLISHING_ADMISSION_ENABLED = Symbol(
  "PUBLISHING_ADMISSION_ENABLED",
);

export interface PublicationRepository {
  createChannel(input: {
    id: string;
    projectId: string;
    platform: PublicationPlatform;
    displayName: string;
    externalChannelRef: string;
    timezone: string;
  }): Promise<PublicationChannelView>;
  listChannels(projectId: string): Promise<PublicationChannelView[]>;
  create(input: {
    id: string;
    idempotencyKey: string;
    requestFingerprint: string;
    projectId: string;
    channelId: string;
    approvalId: string;
    exportResultId: string;
    platform: PublicationPlatform;
    scheduledAt: Date;
    timezone: string;
    metadataSnapshot: Record<string, unknown>;
  }): Promise<PublicationIntentView>;
  get(id: string): Promise<PublicationIntentView | null>;
  listProject(input: {
    projectId: string;
    channelId?: string;
    cursor?: string;
    limit: number;
  }): Promise<PublicationIntentView[]>;
  cancel(id: string, now: Date): Promise<PublicationIntentView>;
}
