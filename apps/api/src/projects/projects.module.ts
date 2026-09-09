import { Module } from "@nestjs/common";
import { AttestSourceAuthorization } from "./application/attest-source-authorization.js";

import { PrismaService } from "../database/prisma.service.js";
import { CreateProjectWithSource } from "./application/create-project-with-source.js";
import { GetProject } from "./application/get-project.js";
import { ListProjects } from "./application/list-projects.js";
import { OBJECT_STORAGE } from "./application/object-storage.port.js";
import { PROJECT_LIBRARY_REPOSITORY } from "./application/project-library-repository.port.js";
import { PROJECT_REPOSITORY } from "./application/project-repository.port.js";
import { ReconcilePendingUploads } from "./application/reconcile-pending-uploads.js";
import { PendingUploadReconciliationStartup } from "./infrastructure/pending-upload-reconciliation.startup.js";
import { PrismaProjectRepository } from "./infrastructure/prisma-project.repository.js";
import { S3ObjectStorage } from "./infrastructure/s3-object-storage.js";
import { TempUploadSweepStartup } from "./infrastructure/temp-upload-sweep.startup.js";
import { ProjectsController } from "./presentation/projects.controller.js";
import { TempUploadLifecycleInterceptor } from "./presentation/temp-upload-lifecycle.interceptor.js";
import { AI_SOURCE_LINEAGE } from "./application/ai-source-lineage.port.js";
import { PrismaAiSourceLineage } from "./infrastructure/prisma-ai-source-lineage.js";

@Module({
  controllers: [ProjectsController],
  providers: [
    AttestSourceAuthorization,
    PrismaService,
    PrismaProjectRepository,
    S3ObjectStorage,
    CreateProjectWithSource,
    GetProject,
    ListProjects,
    ReconcilePendingUploads,
    PendingUploadReconciliationStartup,
    TempUploadSweepStartup,
    TempUploadLifecycleInterceptor,
    PrismaAiSourceLineage,
    { provide: PROJECT_REPOSITORY, useExisting: PrismaProjectRepository },
    {
      provide: PROJECT_LIBRARY_REPOSITORY,
      useExisting: PrismaProjectRepository,
    },
    { provide: OBJECT_STORAGE, useExisting: S3ObjectStorage },
    { provide: AI_SOURCE_LINEAGE, useExisting: PrismaAiSourceLineage },
  ],
  exports: [PrismaService, OBJECT_STORAGE, AI_SOURCE_LINEAGE],
})
export class ProjectsModule {}
