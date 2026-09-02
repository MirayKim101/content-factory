CREATE TYPE "EditorialAssetType" AS ENUM ('THUMBNAIL');
CREATE TYPE "EditorialAssetStatus" AS ENUM ('PENDING', 'READY', 'FAILED_FINAL');

CREATE TABLE "ProcessingTemplate" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcessingTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProcessingTemplateRevision" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "configurationVersion" TEXT NOT NULL DEFAULT 'manual-editorial-v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcessingTemplateRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProcessingTemplateRevision_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "ProcessingTemplateRevision_name_check" CHECK (char_length("name") BETWEEN 1 AND 200),
    CONSTRAINT "ProcessingTemplateRevision_configuration_check" CHECK ("configurationVersion" = 'manual-editorial-v1')
);

CREATE TABLE "EditorialAsset" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "type" "EditorialAssetType" NOT NULL,
    "status" "EditorialAssetStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "storageEtag" TEXT,
    "storageVersion" TEXT,
    "cleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "cleanupLastErrorCode" TEXT,
    "cleanupRequestedAt" TIMESTAMP(3),
    "cleanupCompletedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditorialAsset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EditorialAsset_dimensions_check" CHECK ("width" > 0 AND "height" > 0 AND ("width"::bigint * "height"::bigint) <= 40000000),
    CONSTRAINT "EditorialAsset_size_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760),
    CONSTRAINT "EditorialAsset_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "EditorialAsset_contentType_check" CHECK ("contentType" IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "EditorialAsset_failure_check" CHECK (("status" = 'FAILED_FINAL' AND "failureCode" IS NOT NULL AND "failureMessage" IS NOT NULL) OR ("status" <> 'FAILED_FINAL' AND "failureCode" IS NULL AND "failureMessage" IS NULL))
);

CREATE TABLE "EditorialPackage" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "pipelineJobId" UUID NOT NULL,
    "cutResultArtifactId" UUID NOT NULL,
    "cutResultSha256" TEXT NOT NULL,
    "cutResultSizeBytes" BIGINT NOT NULL,
    "cutResultRecipeVersion" TEXT NOT NULL,
    "lineageSourceId" UUID NOT NULL,
    "lineageSourceVersion" INTEGER NOT NULL,
    "currentRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditorialPackage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EditorialPackage_currentRevision_check" CHECK ("currentRevision" >= 1),
    CONSTRAINT "EditorialPackage_cutResultSha256_check" CHECK ("cutResultSha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "EditorialPackage_cutResultSizeBytes_check" CHECK ("cutResultSizeBytes" > 0),
    CONSTRAINT "EditorialPackage_cutResultRecipeVersion_check" CHECK (char_length("cutResultRecipeVersion") > 0),
    CONSTRAINT "EditorialPackage_lineageSourceVersion_check" CHECK ("lineageSourceVersion" >= 1)
);

CREATE TABLE "EditorialPackageRevision" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "processingTemplateRevisionId" UUID NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "tags" JSONB,
    "thumbnailAssetId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialPackageRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EditorialPackageRevision_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "EditorialPackageRevision_title_check" CHECK ("title" IS NULL OR char_length("title") <= 200),
    CONSTRAINT "EditorialPackageRevision_description_check" CHECK ("description" IS NULL OR char_length("description") <= 5000),
    CONSTRAINT "EditorialPackageRevision_tags_check" CHECK (CASE WHEN "tags" IS NULL THEN TRUE WHEN jsonb_typeof("tags") = 'array' THEN jsonb_array_length("tags") <= 30 ELSE FALSE END)
);

CREATE TABLE "EditorialMutationRequest" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "packageRevisionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialMutationRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcessingTemplate_idempotencyKey_key" ON "ProcessingTemplate"("idempotencyKey");
CREATE UNIQUE INDEX "ProcessingTemplateRevision_templateId_revision_key" ON "ProcessingTemplateRevision"("templateId", "revision");
CREATE INDEX "ProcessingTemplateRevision_createdAt_id_idx" ON "ProcessingTemplateRevision"("createdAt", "id");
CREATE UNIQUE INDEX "EditorialAsset_idempotencyKey_key" ON "EditorialAsset"("idempotencyKey");
CREATE UNIQUE INDEX "EditorialAsset_objectKey_key" ON "EditorialAsset"("objectKey");
CREATE INDEX "EditorialAsset_projectId_type_status_createdAt_idx" ON "EditorialAsset"("projectId", "type", "status", "createdAt");
CREATE INDEX "EditorialAsset_cleanupStatus_updatedAt_idx" ON "EditorialAsset"("cleanupStatus", "updatedAt");
CREATE UNIQUE INDEX "EditorialPackage_pipelineJobId_key" ON "EditorialPackage"("pipelineJobId");
CREATE UNIQUE INDEX "EditorialPackage_cutResultArtifactId_key" ON "EditorialPackage"("cutResultArtifactId");
CREATE INDEX "EditorialPackage_projectId_updatedAt_id_idx" ON "EditorialPackage"("projectId", "updatedAt", "id");
CREATE UNIQUE INDEX "EditorialPackageRevision_packageId_revision_key" ON "EditorialPackageRevision"("packageId", "revision");
CREATE INDEX "EditorialPackageRevision_processingTemplateRevisionId_idx" ON "EditorialPackageRevision"("processingTemplateRevisionId");
CREATE INDEX "EditorialPackageRevision_thumbnailAssetId_idx" ON "EditorialPackageRevision"("thumbnailAssetId");
CREATE UNIQUE INDEX "EditorialMutationRequest_idempotencyKey_key" ON "EditorialMutationRequest"("idempotencyKey");

ALTER TABLE "ProcessingTemplateRevision" ADD CONSTRAINT "ProcessingTemplateRevision_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProcessingTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialAsset" ADD CONSTRAINT "EditorialAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EditorialPackage" ADD CONSTRAINT "EditorialPackage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EditorialPackage" ADD CONSTRAINT "EditorialPackage_pipelineJobId_fkey" FOREIGN KEY ("pipelineJobId") REFERENCES "PipelineJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialPackage" ADD CONSTRAINT "EditorialPackage_cutResultArtifactId_fkey" FOREIGN KEY ("cutResultArtifactId") REFERENCES "MediaArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialPackageRevision" ADD CONSTRAINT "EditorialPackageRevision_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "EditorialPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialPackageRevision" ADD CONSTRAINT "EditorialPackageRevision_processingTemplateRevisionId_fkey" FOREIGN KEY ("processingTemplateRevisionId") REFERENCES "ProcessingTemplateRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialPackageRevision" ADD CONSTRAINT "EditorialPackageRevision_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "EditorialAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialMutationRequest" ADD CONSTRAINT "EditorialMutationRequest_packageRevisionId_fkey" FOREIGN KEY ("packageRevisionId") REFERENCES "EditorialPackageRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
