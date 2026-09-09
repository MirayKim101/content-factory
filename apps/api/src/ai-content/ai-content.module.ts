import { Module } from "@nestjs/common";

import { apiEnvironment } from "../config/environment.js";
import { MediaPipelineModule } from "../media-pipeline/media-pipeline.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import {
  AI_CONTEXT_ADMISSION_ENABLED,
  CREATOR_CONTEXT_REPOSITORY,
} from "./application/creator-context-repository.port.js";
import { CREATOR_CONTEXT_STORAGE } from "./application/creator-context-storage.port.js";
import { CreatorContextService } from "./application/creator-context.service.js";
import {
  RESOLVE_AI_EDITORIAL_CONTEXT,
  ResolveAiEditorialContext,
} from "./application/resolve-ai-editorial-context.port.js";
import { ReconcileCreatorReferences } from "./application/reconcile-creator-references.js";
import { REFERENCE_IMAGE_INSPECTOR } from "./application/reference-image-inspector.port.js";
import { PrismaCreatorContextRepository } from "./infrastructure/prisma-creator-context.repository.js";
import { ProjectObjectCreatorContextStorage } from "./infrastructure/project-object-creator-context-storage.js";
import { StructuralReferenceImageInspector } from "./infrastructure/reference-image-inspector.js";
import { CreatorReferenceReconciliationStartup } from "./infrastructure/creator-reference-reconciliation.startup.js";
import { AiContextAdmissionInterceptor } from "./presentation/ai-context-admission.interceptor.js";
import { CreatorContextController } from "./presentation/creator-context.controller.js";

@Module({
  imports: [ProjectsModule, MediaPipelineModule],
  controllers: [CreatorContextController],
  providers: [
    CreatorContextService,
    ResolveAiEditorialContext,
    ReconcileCreatorReferences,
    CreatorReferenceReconciliationStartup,
    PrismaCreatorContextRepository,
    ProjectObjectCreatorContextStorage,
    StructuralReferenceImageInspector,
    AiContextAdmissionInterceptor,
    {
      provide: CREATOR_CONTEXT_REPOSITORY,
      useExisting: PrismaCreatorContextRepository,
    },
    {
      provide: CREATOR_CONTEXT_STORAGE,
      useExisting: ProjectObjectCreatorContextStorage,
    },
    {
      provide: REFERENCE_IMAGE_INSPECTOR,
      useExisting: StructuralReferenceImageInspector,
    },
    {
      provide: AI_CONTEXT_ADMISSION_ENABLED,
      useFactory: () => apiEnvironment().aiContextEnabled,
    },
    {
      provide: RESOLVE_AI_EDITORIAL_CONTEXT,
      useExisting: ResolveAiEditorialContext,
    },
  ],
  exports: [CreatorContextService, RESOLVE_AI_EDITORIAL_CONTEXT],
})
export class AiContentModule {}
