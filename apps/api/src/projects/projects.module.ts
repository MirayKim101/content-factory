import { Module } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service.js";
import { CreateProjectWithSource } from "./application/create-project-with-source.js";
import { GetProject } from "./application/get-project.js";
import { OBJECT_STORAGE } from "./application/object-storage.port.js";
import { PROJECT_REPOSITORY } from "./application/project-repository.port.js";
import { ReconcilePendingUploads } from "./application/reconcile-pending-uploads.js";
import { PendingUploadReconciliationStartup } from "./infrastructure/pending-upload-reconciliation.startup.js";
import { PrismaProjectRepository } from "./infrastructure/prisma-project.repository.js";
import { S3ObjectStorage } from "./infrastructure/s3-object-storage.js";
import { TempUploadSweepStartup } from "./infrastructure/temp-upload-sweep.startup.js";
import { ProjectsController } from "./presentation/projects.controller.js";
import { TempUploadLifecycleInterceptor } from "./presentation/temp-upload-lifecycle.interceptor.js";

@Module({
  controllers: [ProjectsController],
  providers: [
    PrismaService,
    PrismaProjectRepository,
    S3ObjectStorage,
    CreateProjectWithSource,
    GetProject,
    ReconcilePendingUploads,
    PendingUploadReconciliationStartup,
    TempUploadSweepStartup,
    TempUploadLifecycleInterceptor,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
    { provide: OBJECT_STORAGE, useExisting: S3ObjectStorage },
  ],
})
export class ProjectsModule {}
