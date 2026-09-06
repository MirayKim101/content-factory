import { Module } from "@nestjs/common";

import { ProjectsModule } from "../projects/projects.module.js";
import { CreateCuts } from "./application/create-cuts.js";
import { GetPipelineJob } from "./application/get-pipeline-job.js";
import { ListProjectCutJobs } from "./application/list-project-cut-jobs.js";
import { JOB_DISPATCH } from "./application/job-dispatch.port.js";
import { PIPELINE_REPOSITORY } from "./application/pipeline-repository.port.js";
import { ReconcileMediaJobs } from "./application/reconcile-media-jobs.js";
import {
  BullMqJobDispatch,
  createMediaQueue,
  MEDIA_QUEUE,
} from "./infrastructure/bullmq-job-dispatch.js";
import { MediaReconciliationStartup } from "./infrastructure/media-reconciliation.startup.js";
import { PrismaPipelineRepository } from "./infrastructure/prisma-pipeline.repository.js";
import { MediaPipelineController } from "./presentation/media-pipeline.controller.js";
import { AI_CUT_LINEAGE } from "./application/ai-cut-lineage.port.js";
import { PrismaAiCutLineage } from "./infrastructure/prisma-ai-cut-lineage.js";

@Module({
  imports: [ProjectsModule],
  controllers: [MediaPipelineController],
  providers: [
    PrismaPipelineRepository,
    BullMqJobDispatch,
    CreateCuts,
    GetPipelineJob,
    ListProjectCutJobs,
    ReconcileMediaJobs,
    MediaReconciliationStartup,
    PrismaAiCutLineage,
    { provide: PIPELINE_REPOSITORY, useExisting: PrismaPipelineRepository },
    { provide: JOB_DISPATCH, useExisting: BullMqJobDispatch },
    { provide: MEDIA_QUEUE, useFactory: createMediaQueue },
    { provide: AI_CUT_LINEAGE, useExisting: PrismaAiCutLineage },
  ],
  exports: [JOB_DISPATCH, AI_CUT_LINEAGE],
})
export class MediaPipelineModule {}
