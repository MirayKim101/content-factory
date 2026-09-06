import { Module } from "@nestjs/common";
import { MONTAGE_REPOSITORY } from "./application/montage-repository.port.js";
import { UploadMontageAsset } from "./application/upload-montage-asset.js";
import { ReconcileMontageAssets } from "./application/reconcile-montage-assets.js";
import { PrismaMontageRepository } from "./infrastructure/prisma-montage.repository.js";
import { MontageReconciliationStartup } from "./infrastructure/montage-reconciliation.startup.js";
import { MontageController } from "./presentation/montage.controller.js";
import { MontageUploadAdmissionInterceptor } from "./presentation/montage-upload-admission.interceptor.js";
import { ASSEMBLY_RECIPE_REPOSITORY } from "./application/assembly-recipe-repository.port.js";
import {
  GetAssemblyRecipe,
  GetAssemblyRecipeRevision,
  ListAssemblyRecipes,
} from "./application/assembly-recipe-queries.js";
import { SaveAssemblyRecipe } from "./application/save-assembly-recipe.js";
import { PrismaAssemblyRecipeRepository } from "./infrastructure/prisma-assembly-recipe.repository.js";
import { AssemblyRecipeController } from "./presentation/assembly-recipe.controller.js";
import { MediaPipelineModule } from "../media-pipeline/media-pipeline.module.js";
import { apiEnvironment } from "../config/environment.js";
import {
  ASSEMBLY_RENDER_ADMISSION_ENABLED,
  ASSEMBLY_RENDER_REPOSITORY,
} from "./application/assembly-render-repository.port.js";
import { CreateAssemblyRender } from "./application/create-assembly-render.js";
import {
  GetAssemblyRender,
  GetAssemblyRenderContent,
  ListAssemblyRenders,
} from "./application/assembly-render-queries.js";
import { PrismaAssemblyRenderRepository } from "./infrastructure/prisma-assembly-render.repository.js";
import { AssemblyRenderController } from "./presentation/assembly-render.controller.js";
import {
  EDITORIAL_APPROVAL_ADMISSION_ENABLED,
  EDITORIAL_APPROVAL_REPOSITORY,
} from "./application/editorial-approval-repository.port.js";
import { CreateEditorialApproval } from "./application/create-editorial-approval.js";
import {
  GetEditorialReview,
  ListEditorialApprovals,
} from "./application/editorial-approval-queries.js";
import { PrismaEditorialApprovalRepository } from "./infrastructure/prisma-editorial-approval.repository.js";
import { EditorialApprovalController } from "./presentation/editorial-approval.controller.js";

import { ProjectsModule } from "../projects/projects.module.js";
import { TempUploadLifecycleInterceptor } from "../projects/presentation/temp-upload-lifecycle.interceptor.js";
import { CreateProcessingTemplate } from "./application/create-processing-template.js";
import {
  GetEditorialAsset,
  GetEditorialPackage,
  ListEditorialAssets,
  ListEditorialPackages,
} from "./application/editorial-queries.js";
import { EDITORIAL_REPOSITORY } from "./application/editorial-repository.port.js";
import { EDITORIAL_STORAGE } from "./application/editorial-storage.port.js";
import { ListProcessingTemplates } from "./application/list-processing-templates.js";
import { SaveEditorialPackage } from "./application/save-editorial-package.js";
import { UploadThumbnail } from "./application/upload-thumbnail.js";
import { ReconcileEditorialAssets } from "./application/reconcile-editorial-assets.js";
import { EditorialAssetReconciliationStartup } from "./infrastructure/editorial-asset-reconciliation.startup.js";
import { PrismaEditorialRepository } from "./infrastructure/prisma-editorial.repository.js";
import { ProjectObjectEditorialStorage } from "./infrastructure/project-object-editorial-storage.js";
import { EditorialController } from "./presentation/editorial.controller.js";

@Module({
  imports: [ProjectsModule, MediaPipelineModule],
  controllers: [
    EditorialController,
    MontageController,
    AssemblyRecipeController,
    AssemblyRenderController,
    EditorialApprovalController,
  ],
  providers: [
    PrismaAssemblyRecipeRepository,
    PrismaAssemblyRenderRepository,
    PrismaEditorialApprovalRepository,
    CreateEditorialApproval,
    GetEditorialReview,
    ListEditorialApprovals,
    {
      provide: EDITORIAL_APPROVAL_REPOSITORY,
      useExisting: PrismaEditorialApprovalRepository,
    },
    {
      provide: EDITORIAL_APPROVAL_ADMISSION_ENABLED,
      useFactory: () => apiEnvironment().editorialApprovalEnabled,
    },
    CreateAssemblyRender,
    GetAssemblyRender,
    GetAssemblyRenderContent,
    ListAssemblyRenders,
    {
      provide: ASSEMBLY_RENDER_REPOSITORY,
      useExisting: PrismaAssemblyRenderRepository,
    },
    {
      provide: ASSEMBLY_RENDER_ADMISSION_ENABLED,
      useFactory: () => apiEnvironment().assemblyRenderEnabled,
    },
    SaveAssemblyRecipe,
    GetAssemblyRecipe,
    GetAssemblyRecipeRevision,
    ListAssemblyRecipes,
    {
      provide: ASSEMBLY_RECIPE_REPOSITORY,
      useExisting: PrismaAssemblyRecipeRepository,
    },
    PrismaMontageRepository,
    UploadMontageAsset,
    ReconcileMontageAssets,
    MontageReconciliationStartup,
    MontageUploadAdmissionInterceptor,
    { provide: MONTAGE_REPOSITORY, useExisting: PrismaMontageRepository },
    PrismaEditorialRepository,
    ProjectObjectEditorialStorage,
    CreateProcessingTemplate,
    ListProcessingTemplates,
    UploadThumbnail,
    ListEditorialAssets,
    GetEditorialAsset,
    SaveEditorialPackage,
    ReconcileEditorialAssets,
    EditorialAssetReconciliationStartup,
    GetEditorialPackage,
    ListEditorialPackages,
    TempUploadLifecycleInterceptor,
    { provide: EDITORIAL_REPOSITORY, useExisting: PrismaEditorialRepository },
    {
      provide: EDITORIAL_STORAGE,
      useExisting: ProjectObjectEditorialStorage,
    },
  ],
})
export class EditorialContentModule {}
