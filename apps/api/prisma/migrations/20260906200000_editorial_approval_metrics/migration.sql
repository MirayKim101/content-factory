-- ADR-007 Stage 2d: exact immutable editorial approval and metrics snapshot.
-- Additive only; approval admission remains disabled until independent review.
CREATE TYPE "EditorialOperationType" AS ENUM (
  'CREATE_EDITORIAL_APPROVAL',
  'CREATE_EDITORIAL_EXPORT'
);

CREATE UNIQUE INDEX "EditorialAsset_id_projectId_key"
  ON "EditorialAsset"("id", "projectId");
CREATE UNIQUE INDEX "EditorialPackageRevision_exact_identity_key"
  ON "EditorialPackageRevision"("id", "packageId", "revision");
CREATE UNIQUE INDEX "AssemblyRenderResult_exact_identity_key"
  ON "AssemblyRenderResult"("id", "renderIntentId", "artifactId");

CREATE TABLE "EditorialApproval" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceId" UUID NOT NULL REFERENCES "VideoSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceVersion" INTEGER NOT NULL CHECK ("sourceVersion" > 0),
  "cutPipelineJobId" UUID NOT NULL,
  "editorialPackageId" UUID NOT NULL REFERENCES "EditorialPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "editorialPackageRevisionId" UUID NOT NULL,
  "editorialRevision" INTEGER NOT NULL CHECK ("editorialRevision" > 0),
  "processingTemplateRevisionId" UUID NOT NULL REFERENCES "ProcessingTemplateRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "thumbnailAssetId" UUID NOT NULL,
  "thumbnailSha256" TEXT NOT NULL CHECK ("thumbnailSha256" ~ '^[a-f0-9]{64}$'),
  "thumbnailSizeBytes" BIGINT NOT NULL CHECK ("thumbnailSizeBytes" > 0),
  "thumbnailContentType" TEXT NOT NULL CHECK ("thumbnailContentType" IN ('image/jpeg','image/png','image/webp')),
  "assemblyRecipeId" UUID NOT NULL REFERENCES "AssemblyRecipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recipeRevisionId" UUID NOT NULL,
  "recipeRevision" INTEGER NOT NULL CHECK ("recipeRevision" > 0),
  "configurationFingerprint" TEXT NOT NULL CHECK ("configurationFingerprint" ~ '^[a-f0-9]{64}$'),
  "assemblyRenderIntentId" UUID NOT NULL,
  "assemblyRenderResultId" UUID NOT NULL,
  "renderArtifactId" UUID NOT NULL REFERENCES "MediaArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "renderArtifactSha256" TEXT NOT NULL CHECK ("renderArtifactSha256" ~ '^[a-f0-9]{64}$'),
  "renderArtifactSizeBytes" BIGINT NOT NULL CHECK ("renderArtifactSizeBytes" > 0),
  "renderContractVersion" TEXT NOT NULL CHECK ("renderContractVersion" = 'horizontal-render-v1'),
  "approvalContractVersion" TEXT NOT NULL DEFAULT 'manual-horizontal-approval-v1'
    CHECK ("approvalContractVersion" = 'manual-horizontal-approval-v1'),
  "candidateFingerprint" TEXT NOT NULL CHECK ("candidateFingerprint" ~ '^[a-f0-9]{64}$'),
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialApproval_exact_cut_job"
    FOREIGN KEY ("cutPipelineJobId", "projectId", "sourceId", "sourceVersion")
    REFERENCES "PipelineJob"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialApproval_exact_editorial_revision"
    FOREIGN KEY ("editorialPackageRevisionId", "editorialPackageId", "editorialRevision")
    REFERENCES "EditorialPackageRevision"("id", "packageId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialApproval_exact_thumbnail_project"
    FOREIGN KEY ("thumbnailAssetId", "projectId")
    REFERENCES "EditorialAsset"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialApproval_exact_recipe_revision"
    FOREIGN KEY ("recipeRevisionId", "assemblyRecipeId", "recipeRevision")
    REFERENCES "AssemblyRecipeRevision"("id", "recipeId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialApproval_exact_render_intent"
    FOREIGN KEY ("assemblyRenderIntentId", "projectId", "sourceId", "sourceVersion")
    REFERENCES "AssemblyRenderIntent"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialApproval_exact_render_result"
    FOREIGN KEY ("assemblyRenderResultId", "assemblyRenderIntentId", "renderArtifactId")
    REFERENCES "AssemblyRenderResult"("id", "renderIntentId", "artifactId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialApproval_logical_key"
    UNIQUE ("editorialPackageRevisionId", "assemblyRenderResultId", "approvalContractVersion")
);
CREATE UNIQUE INDEX "EditorialApproval_id_projectId_key" ON "EditorialApproval"("id", "projectId");
CREATE INDEX "EditorialApproval_projectId_approvedAt_id_idx" ON "EditorialApproval"("projectId", "approvedAt", "id");
CREATE INDEX "EditorialApproval_cutPipelineJobId_approvedAt_id_idx" ON "EditorialApproval"("cutPipelineJobId", "approvedAt", "id");

CREATE TABLE "EditorialApprovalMetrics" (
  "approvalId" UUID PRIMARY KEY REFERENCES "EditorialApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "metricsSchemaVersion" TEXT NOT NULL DEFAULT 'approval-metrics-v1' CHECK ("metricsSchemaVersion" = 'approval-metrics-v1'),
  "timestampBasisVersion" TEXT NOT NULL DEFAULT 'persisted-job-attempt-v1' CHECK ("timestampBasisVersion" = 'persisted-job-attempt-v1'),
  "cutInitialQueueWaitMs" BIGINT,
  "cutRetryWaitMs" BIGINT,
  "cutFirstStartToFinishMs" BIGINT,
  "cutActiveAttemptMs" BIGINT,
  "cutAttemptCount" INTEGER NOT NULL CHECK ("cutAttemptCount" >= 0),
  "cutRetryCount" INTEGER NOT NULL CHECK ("cutRetryCount" >= 0 AND "cutRetryCount" = GREATEST("cutAttemptCount" - 1, 0)),
  "assemblyInitialQueueWaitMs" BIGINT,
  "assemblyRetryWaitMs" BIGINT,
  "assemblyFirstStartToFinishMs" BIGINT,
  "assemblyActiveAttemptMs" BIGINT,
  "assemblyAttemptCount" INTEGER NOT NULL CHECK ("assemblyAttemptCount" >= 0),
  "assemblyRetryCount" INTEGER NOT NULL CHECK ("assemblyRetryCount" >= 0 AND "assemblyRetryCount" = GREATEST("assemblyAttemptCount" - 1, 0)),
  "cutToAssemblyReadyElapsedMs" BIGINT,
  "outputDurationMs" INTEGER NOT NULL CHECK ("outputDurationMs" > 0),
  "outputBytes" BIGINT NOT NULL CHECK ("outputBytes" > 0),
  "manualAttentionMs" INTEGER NOT NULL CHECK ("manualAttentionMs" >= 0 AND "manualAttentionMs" <= 28800000),
  "attentionMeasurementVersion" TEXT NOT NULL CHECK ("attentionMeasurementVersion" = 'foreground-preview-v1'),
  "directProviderCostMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("directProviderCostMinor" = 0),
  "costCurrency" TEXT NOT NULL DEFAULT 'RUB' CHECK ("costCurrency" = 'RUB'),
  "costBasisVersion" TEXT NOT NULL DEFAULT 'local-direct-provider-cost-v1' CHECK ("costBasisVersion" = 'local-direct-provider-cost-v1'),
  "incompleteReasons" JSONB NOT NULL CHECK (jsonb_typeof("incompleteReasons") = 'array'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialApprovalMetrics_nonnegative_durations" CHECK (
    ("cutInitialQueueWaitMs" IS NULL OR "cutInitialQueueWaitMs" >= 0) AND
    ("cutRetryWaitMs" IS NULL OR "cutRetryWaitMs" >= 0) AND
    ("cutFirstStartToFinishMs" IS NULL OR "cutFirstStartToFinishMs" >= 0) AND
    ("cutActiveAttemptMs" IS NULL OR "cutActiveAttemptMs" >= 0) AND
    ("assemblyInitialQueueWaitMs" IS NULL OR "assemblyInitialQueueWaitMs" >= 0) AND
    ("assemblyRetryWaitMs" IS NULL OR "assemblyRetryWaitMs" >= 0) AND
    ("assemblyFirstStartToFinishMs" IS NULL OR "assemblyFirstStartToFinishMs" >= 0) AND
    ("assemblyActiveAttemptMs" IS NULL OR "assemblyActiveAttemptMs" >= 0) AND
    ("cutToAssemblyReadyElapsedMs" IS NULL OR "cutToAssemblyReadyElapsedMs" >= 0)
  )
);

CREATE TABLE "EditorialOperationRequest" (
  "id" UUID PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "operation" "EditorialOperationType" NOT NULL,
  "canonicalRequestFingerprint" TEXT NOT NULL CHECK ("canonicalRequestFingerprint" ~ '^[a-f0-9]{64}$'),
  "resolvedProjectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "approvalId" UUID REFERENCES "EditorialApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "exportIntentId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialOperationRequest_result_shape" CHECK (
    ("operation" = 'CREATE_EDITORIAL_APPROVAL' AND "approvalId" IS NOT NULL AND "exportIntentId" IS NULL)
    OR ("operation" = 'CREATE_EDITORIAL_EXPORT' AND "approvalId" IS NULL AND "exportIntentId" IS NOT NULL)
  )
);
CREATE INDEX "EditorialOperationRequest_resolvedProjectId_createdAt_id_idx"
  ON "EditorialOperationRequest"("resolvedProjectId", "createdAt", "id");
CREATE INDEX "EditorialOperationRequest_approvalId_idx" ON "EditorialOperationRequest"("approvalId");
CREATE INDEX "EditorialOperationRequest_exportIntentId_idx" ON "EditorialOperationRequest"("exportIntentId");
