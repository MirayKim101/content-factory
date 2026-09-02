import { Module } from "@nestjs/common";

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
  imports: [ProjectsModule],
  controllers: [EditorialController],
  providers: [
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
