import { Module } from "@nestjs/common";

import { apiEnvironment } from "../config/environment.js";
import { MediaPipelineModule } from "../media-pipeline/media-pipeline.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { EditorialContentModule } from "../editorial-content/editorial-content.module.js";
import { ApplyResearchMetadata } from "./application/apply-research-metadata.js";
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
import { FrameEvidenceController } from "./presentation/frame-evidence.controller.js";
import { PrismaFrameEvidenceRepository } from "./infrastructure/prisma-frame-evidence.repository.js";
import { FRAME_EVIDENCE_REPOSITORY } from "./application/frame-evidence-repository.port.js";
import { TRANSCRIPT_EVIDENCE_REPOSITORY } from "./application/transcript-evidence-repository.port.js";
import { PrismaTranscriptEvidenceRepository } from "./infrastructure/prisma-transcript-evidence.repository.js";
import { TranscriptEvidenceController } from "./presentation/transcript-evidence.controller.js";
import { ResearchController } from "./research/research.controller.js";
import { PrismaResearchSuggestionRepository } from "./infrastructure/prisma-research-suggestion.repository.js";
import { RESEARCH_SUGGESTION_REPOSITORY } from "./application/research-suggestion-repository.port.js";
import { RESEARCH_SUGGESTION_DISPATCH } from "./application/research-suggestion-dispatch.port.js";
import {
  BullMqResearchDispatch,
  createResearchQueue,
  RESEARCH_QUEUE,
} from "./infrastructure/bullmq-research-dispatch.js";
import {
  TRANSCRIPT_QUEUE,
  BullMqTranscriptDispatch,
  createTranscriptQueue,
} from "./infrastructure/bullmq-transcript-dispatch.js";
import { TRANSCRIPT_EVIDENCE_DISPATCH } from "./application/transcript-evidence-dispatch.port.js";
import { ApplyImageSuggestion } from "./application/apply-image-suggestion.js";
import { ImageSuggestionController } from "./presentation/image-suggestion.controller.js";
import { PrismaImageSuggestionRepository } from "./infrastructure/prisma-image-suggestion.repository.js";
import { IMAGE_SUGGESTION_REPOSITORY } from "./application/image-suggestion-repository.port.js";
import { IMAGE_SUGGESTION_DISPATCH } from "./application/image-suggestion-dispatch.port.js";
import {
  BullMqImageSuggestionDispatch,
  createImageSuggestionQueue,
  IMAGE_SUGGESTION_QUEUE,
} from "./infrastructure/bullmq-image-suggestion-dispatch.js";

@Module({
  imports: [ProjectsModule, MediaPipelineModule, EditorialContentModule],
  controllers: [
    CreatorContextController,
    FrameEvidenceController,
    TranscriptEvidenceController,
    ResearchController,
    ImageSuggestionController,
  ],
  providers: [
    CreatorContextService,
    ApplyResearchMetadata,
    ApplyImageSuggestion,
    PrismaFrameEvidenceRepository,
    PrismaTranscriptEvidenceRepository,
    PrismaResearchSuggestionRepository,
    BullMqTranscriptDispatch,
    BullMqResearchDispatch,
    PrismaImageSuggestionRepository,
    BullMqImageSuggestionDispatch,
    {
      provide: TRANSCRIPT_QUEUE,
      useFactory: createTranscriptQueue,
    },
    {
      provide: TRANSCRIPT_EVIDENCE_DISPATCH,
      useExisting: BullMqTranscriptDispatch,
    },
    {
      provide: RESEARCH_QUEUE,
      useFactory: createResearchQueue,
    },
    {
      provide: RESEARCH_SUGGESTION_DISPATCH,
      useExisting: BullMqResearchDispatch,
    },
    {
      provide: IMAGE_SUGGESTION_QUEUE,
      useFactory: createImageSuggestionQueue,
    },
    {
      provide: IMAGE_SUGGESTION_DISPATCH,
      useExisting: BullMqImageSuggestionDispatch,
    },
    {
      provide: FRAME_EVIDENCE_REPOSITORY,
      useExisting: PrismaFrameEvidenceRepository,
    },
    {
      provide: TRANSCRIPT_EVIDENCE_REPOSITORY,
      useExisting: PrismaTranscriptEvidenceRepository,
    },
    {
      provide: RESEARCH_SUGGESTION_REPOSITORY,
      useExisting: PrismaResearchSuggestionRepository,
    },
    {
      provide: IMAGE_SUGGESTION_REPOSITORY,
      useExisting: PrismaImageSuggestionRepository,
    },
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
