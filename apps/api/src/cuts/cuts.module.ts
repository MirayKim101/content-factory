import { Module } from "@nestjs/common";
import { PrismaCutJobRepository } from "@content-factory/manual-cut";

import { PrismaService } from "../database/prisma.service.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { BullCutQueue } from "./bull-cut-queue.js";
import { CutJobService } from "./cut-job.service.js";
import { CUT_JOB_REPOSITORY, CUT_QUEUE_PUBLISHER } from "./cut.tokens.js";
import { CutsController } from "./cuts.controller.js";
import { MediaStreamService } from "./media-stream.js";

@Module({
  imports: [ProjectsModule],
  controllers: [CutsController],
  providers: [
    BullCutQueue,
    CutJobService,
    MediaStreamService,
    {
      provide: CUT_JOB_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaCutJobRepository(prisma),
    },
    { provide: CUT_QUEUE_PUBLISHER, useExisting: BullCutQueue },
  ],
})
export class CutsModule {}
