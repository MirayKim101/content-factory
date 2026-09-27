import { Module } from "@nestjs/common";

import { publishingAdmissionEnabled } from "../config/environment.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { CreatePublicationIntent } from "./application/create-publication-intent.js";
import {
  CreatePublicationChannel,
  ListPublicationChannels,
} from "./application/publication-channel-commands.js";
import {
  CancelPublicationIntent,
  GetPublicationIntent,
  ListPublicationIntents,
} from "./application/publication-queries.js";
import {
  PUBLICATION_REPOSITORY,
  PUBLISHING_ADMISSION_ENABLED,
} from "./application/publication-repository.port.js";
import { PrismaPublicationRepository } from "./infrastructure/prisma-publication.repository.js";
import { PublicationController } from "./presentation/publication.controller.js";

@Module({
  imports: [ProjectsModule],
  controllers: [PublicationController],
  providers: [
    PrismaPublicationRepository,
    CreatePublicationIntent,
    CreatePublicationChannel,
    ListPublicationChannels,
    GetPublicationIntent,
    ListPublicationIntents,
    CancelPublicationIntent,
    {
      provide: PUBLICATION_REPOSITORY,
      useExisting: PrismaPublicationRepository,
    },
    {
      provide: PUBLISHING_ADMISSION_ENABLED,
      useFactory: () => publishingAdmissionEnabled(process.env),
    },
  ],
})
export class PublishingModule {}
