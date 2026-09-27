import { Module } from "@nestjs/common";

import { publishingAdmissionEnabled } from "../config/environment.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { CreatePublicationIntent } from "./application/create-publication-intent.js";
import {
  PUBLICATION_REPOSITORY,
  PUBLISHING_ADMISSION_ENABLED,
} from "./application/publication-repository.port.js";
import { PrismaPublicationRepository } from "./infrastructure/prisma-publication.repository.js";

@Module({
  imports: [ProjectsModule],
  providers: [
    PrismaPublicationRepository,
    CreatePublicationIntent,
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
