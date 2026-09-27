import { Module } from "@nestjs/common";

import { publishingAdmissionEnabled } from "../config/environment.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { CreatePublicationIntent } from "./application/create-publication-intent.js";
import { GetTikTokCreatorInfo } from "./application/get-tiktok-creator-info.js";
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
  TIKTOK_PUBLISHING_ADMISSION_ENABLED,
  YOUTUBE_PUBLISHING_ADMISSION_ENABLED,
} from "./application/publication-repository.port.js";
import { PrismaPublicationRepository } from "./infrastructure/prisma-publication.repository.js";
import { PublicationController } from "./presentation/publication.controller.js";
import { PUBLICATION_DISPATCH } from "./application/publication-dispatch.port.js";
import { BullMqPublicationDispatch } from "./infrastructure/bullmq-publication-dispatch.js";

@Module({
  imports: [ProjectsModule],
  controllers: [PublicationController],
  providers: [
    PrismaPublicationRepository,
    BullMqPublicationDispatch,
    CreatePublicationIntent,
    GetTikTokCreatorInfo,
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
    {
      provide: YOUTUBE_PUBLISHING_ADMISSION_ENABLED,
      useFactory: () => process.env.YOUTUBE_PUBLISHING_ENABLED?.trim() === "1",
    },
    {
      provide: TIKTOK_PUBLISHING_ADMISSION_ENABLED,
      useFactory: () => process.env.TIKTOK_PUBLISHING_ENABLED?.trim() === "1",
    },
    {
      provide: PUBLICATION_DISPATCH,
      useExisting: BullMqPublicationDispatch,
    },
  ],
})
export class PublishingModule {}
