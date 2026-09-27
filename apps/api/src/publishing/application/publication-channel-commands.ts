import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type { PublicationPlatform } from "@content-factory/contracts";

import {
  PublishingUnavailableError,
  requirePublicationLabel,
  requirePublicationTimezone,
} from "../domain/publication.js";
import {
  PUBLICATION_REPOSITORY,
  PUBLISHING_ADMISSION_ENABLED,
  YOUTUBE_PUBLISHING_ADMISSION_ENABLED,
  type PublicationRepository,
} from "./publication-repository.port.js";

@Injectable()
export class CreatePublicationChannel {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
    @Inject(PUBLISHING_ADMISSION_ENABLED)
    private readonly admissionEnabled: boolean,
    @Inject(YOUTUBE_PUBLISHING_ADMISSION_ENABLED)
    private readonly youtubeAdmissionEnabled: boolean,
  ) {}

  async execute(input: {
    projectId: string;
    platform: PublicationPlatform;
    displayName: string;
    externalChannelRef: string;
    timezone: string;
  }) {
    if (
      !this.admissionEnabled ||
      (input.platform !== "LOCAL_DRY_RUN" &&
        !(input.platform === "YOUTUBE" && this.youtubeAdmissionEnabled))
    )
      throw new PublishingUnavailableError();
    return this.repository.createChannel({
      id: randomUUID(),
      projectId: input.projectId,
      platform: input.platform,
      displayName: requirePublicationLabel(input.displayName, 120),
      externalChannelRef: requirePublicationLabel(
        input.externalChannelRef,
        255,
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
