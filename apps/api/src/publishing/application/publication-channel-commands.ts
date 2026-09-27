import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type { PublicationPlatform } from "@content-factory/contracts";

import {
  requirePublicationLabel,
  requirePublicationTimezone,
} from "../domain/publication.js";
import {
  PUBLICATION_REPOSITORY,
  type PublicationRepository,
} from "./publication-repository.port.js";

@Injectable()
export class CreatePublicationChannel {
  constructor(
    @Inject(PUBLICATION_REPOSITORY)
    private readonly repository: PublicationRepository,
  ) {}

  execute(input: {
    projectId: string;
    platform: PublicationPlatform;
    displayName: string;
    externalChannelRef: string;
    timezone: string;
  }) {
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
