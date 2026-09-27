import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type { PublicationPlatform } from "@content-factory/contracts";

import {
  PublishingUnavailableError,
  requirePublicationExternalChannelRef,
  requirePublicationLabel,
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
  publicationPlatformEnabled,
  resolvePublishingCapabilities,
} from "./publishing-admission.js";

@Injectable()
export class CreatePublicationChannel {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
    @Inject(PUBLISHING_ADMISSION_ENABLED)
    private readonly admissionEnabled: boolean,
    @Inject(YOUTUBE_PUBLISHING_ADMISSION_ENABLED)
    private readonly youtubeAdmissionEnabled: boolean,
    @Inject(TIKTOK_PUBLISHING_ADMISSION_ENABLED)
    private readonly tiktokAdmissionEnabled: boolean,
  ) {}

  async execute(input: {
    projectId: string;
    platform: PublicationPlatform;
    displayName: string;
    externalChannelRef: string;
    timezone: string;
  }) {
    if (
      !publicationPlatformEnabled(
        resolvePublishingCapabilities(
          this.admissionEnabled,
          this.youtubeAdmissionEnabled,
          this.tiktokAdmissionEnabled,
        ),
        input.platform,
      )
    )
      throw new PublishingUnavailableError();
    return this.repository.createChannel({
      id: randomUUID(),
      projectId: input.projectId,
      platform: input.platform,
      displayName: requirePublicationLabel(input.displayName, 120),
      externalChannelRef: requirePublicationExternalChannelRef(
        input.platform,
        input.externalChannelRef,
      ),
      timezone: requirePublicationTimezone(input.timezone),
    });
  }
}

@Injectable()
export class ListPublicationChannels {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
  ) {}
  execute(projectId: string) {
    return this.repository.listChannels(projectId);
  }
}

@Injectable()
export class RevokePublicationChannel {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
  ) {}

  execute(projectId: string, channelId: string, now = new Date()) {
    return this.repository.revokeChannel(projectId, channelId, now);
  }
}

@Injectable()
export class GetPublishingCapabilities {
  constructor(
    @Inject(PUBLISHING_ADMISSION_ENABLED)
    private readonly admissionEnabled: boolean,
    @Inject(YOUTUBE_PUBLISHING_ADMISSION_ENABLED)
    private readonly youtubeAdmissionEnabled: boolean,
    @Inject(TIKTOK_PUBLISHING_ADMISSION_ENABLED)
    private readonly tiktokAdmissionEnabled: boolean,
  ) {}

  execute() {
    return resolvePublishingCapabilities(
      this.admissionEnabled,
      this.youtubeAdmissionEnabled,
      this.tiktokAdmissionEnabled,
    );
  }
}
