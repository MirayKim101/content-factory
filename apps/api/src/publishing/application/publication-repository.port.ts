import type { PublicationPlatform } from "@content-factory/contracts";

import type { PublicationIntentView } from "../domain/publication.js";

export const PUBLICATION_REPOSITORY = Symbol("PUBLICATION_REPOSITORY");
export const PUBLISHING_ADMISSION_ENABLED = Symbol(
  "PUBLISHING_ADMISSION_ENABLED",
);

export interface PublicationRepository {
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
}
