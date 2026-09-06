CREATE TYPE "CreatorLikenessPolicy" AS ENUM ('NO_REALISTIC_LIKENESS', 'CLEARED_REFERENCE_ONLY');
CREATE TYPE "CreatorReferenceAssetStatus" AS ENUM ('PENDING', 'READY', 'FAILED_FINAL');
CREATE TYPE "CreatorReferenceAuthorizationStatus" AS ENUM ('NOT_REVIEWED', 'CLEARED', 'REVOKED');
CREATE TYPE "AiContentOperationType" AS ENUM ('CREATE_CREATOR_PROFILE', 'UPDATE_CREATOR_PROFILE', 'UPLOAD_CREATOR_REFERENCE', 'UPDATE_CREATOR_REFERENCE_AUTHORIZATION', 'SET_DEFAULT_CREATOR_REFERENCE', 'PUT_SOURCE_EDITORIAL_CONTEXT', 'PUT_CUT_EDITORIAL_PROMPT');
CREATE TYPE "EditorialComponentType" AS ENUM ('METADATA', 'THUMBNAIL');
CREATE TYPE "EditorialProvenanceMode" AS ENUM ('MANUAL', 'AI_ASSISTED', 'MIXED');

CREATE TABLE "CreatorProfile" (
  "id" UUID NOT NULL,
  "currentRevision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorProfile_currentRevision_check" CHECK ("currentRevision" > 0)
);

CREATE TABLE "CreatorProfileOfficialUrlIdentity" (
  "id" UUID NOT NULL,
  "creatorProfileId" UUID NOT NULL,
  "canonicalizationVersion" TEXT NOT NULL DEFAULT 'creator-official-url-v1',
  "canonicalUrl" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorProfileOfficialUrlIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorProfileOfficialUrlIdentity_url_check" CHECK ("canonicalizationVersion" = 'creator-official-url-v1' AND "canonicalUrl" LIKE 'https://%')
);

CREATE TABLE "CreatorProfileRevision" (
  "id" UUID NOT NULL,
  "creatorProfileId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "canonicalDisplayName" TEXT NOT NULL,
  "officialUrlIdentityId" UUID NOT NULL,
  "officialUrl" TEXT NOT NULL,
  "primaryLanguage" TEXT NOT NULL,
  "topics" JSONB NOT NULL,
  "editorialNotes" TEXT NOT NULL,
  "restrictions" JSONB NOT NULL,
  "likenessPolicy" "CreatorLikenessPolicy" NOT NULL DEFAULT 'NO_REALISTIC_LIKENESS',
  "defaultReferenceAssetId" UUID,
  "defaultReferenceAuthorizationRevisionId" UUID,
  "defaultReferenceAuthorizationRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorProfileRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorProfileRevision_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "CreatorProfileRevision_json_check" CHECK (jsonb_typeof("topics") = 'array' AND jsonb_typeof("restrictions") = 'array'),
  CONSTRAINT "CreatorProfileRevision_default_reference_check" CHECK (
    ("likenessPolicy" = 'NO_REALISTIC_LIKENESS' AND "defaultReferenceAssetId" IS NULL AND "defaultReferenceAuthorizationRevisionId" IS NULL AND "defaultReferenceAuthorizationRevision" IS NULL)
    OR
    ("likenessPolicy" = 'CLEARED_REFERENCE_ONLY' AND "defaultReferenceAssetId" IS NOT NULL AND "defaultReferenceAuthorizationRevisionId" IS NOT NULL AND "defaultReferenceAuthorizationRevision" > 0)
  )
);

CREATE TABLE "CreatorReferenceAsset" (
  "id" UUID NOT NULL,
  "creatorProfileId" UUID NOT NULL,
  "status" "CreatorReferenceAssetStatus" NOT NULL DEFAULT 'PENDING',
  "currentAuthorizationRevision" INTEGER NOT NULL DEFAULT 1,
  "objectKey" TEXT NOT NULL,
  "originalFilename" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "storageEtag" TEXT,
  "storageVersion" TEXT,
  "failureCode" TEXT,
  "cleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "cleanupLastErrorCode" TEXT,
  "cleanupRequestedAt" TIMESTAMP(3),
  "cleanupCompletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorReferenceAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorReferenceAsset_shape_check" CHECK (
    "currentAuthorizationRevision" > 0 AND
    "contentType" IN ('image/jpeg', 'image/png', 'image/webp') AND
    "sizeBytes" > 0 AND "sizeBytes" <= 10485760 AND
    "sha256" ~ '^[a-f0-9]{64}$' AND
    "width" > 0 AND "height" > 0 AND ("width"::BIGINT * "height"::BIGINT) <= 40000000
  )
);

CREATE TABLE "CreatorReferenceAuthorizationRevision" (
  "id" UUID NOT NULL,
  "referenceAssetId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "CreatorReferenceAuthorizationStatus" NOT NULL DEFAULT 'NOT_REVIEWED',
  "declarationVersion" TEXT,
  "commercialAiImageUseAttested" BOOLEAN NOT NULL DEFAULT false,
  "basis" TEXT,
  "scope" TEXT,
  "expiresAt" TIMESTAMP(3),
  "externalProviderTransferAllowed" BOOLEAN NOT NULL DEFAULT false,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorReferenceAuthorizationRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreatorReferenceAuthorizationRevision_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "CreatorReferenceAuthorizationRevision_decision_check" CHECK (
    ("status" = 'NOT_REVIEWED' AND "declarationVersion" IS NULL AND NOT "commercialAiImageUseAttested" AND "basis" IS NULL AND "scope" IS NULL AND "expiresAt" IS NULL AND NOT "externalProviderTransferAllowed" AND "decidedAt" IS NULL)
    OR
    ("status" = 'CLEARED' AND "declarationVersion" = 'creator-likeness-rights-v1' AND "commercialAiImageUseAttested" AND "basis" IS NOT NULL AND length(trim("basis")) > 0 AND "scope" IS NOT NULL AND length(trim("scope")) > 0 AND "decidedAt" IS NOT NULL)
    OR
    ("status" = 'REVOKED' AND "declarationVersion" IS NULL AND NOT "commercialAiImageUseAttested" AND "basis" IS NULL AND "scope" IS NULL AND "expiresAt" IS NULL AND NOT "externalProviderTransferAllowed" AND "decidedAt" IS NOT NULL)
  )
);

CREATE TABLE "SourceEditorialContext" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "currentRevision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SourceEditorialContext_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceEditorialContext_revision_check" CHECK ("sourceVersion" > 0 AND "currentRevision" > 0)
);

CREATE TABLE "SourceEditorialContextRevision" (
  "id" UUID NOT NULL,
  "contextId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "creatorProfileId" UUID NOT NULL,
  "creatorProfileRevisionId" UUID NOT NULL,
  "creatorProfileRevisionNo" INTEGER NOT NULL,
  "sourceTitle" TEXT NOT NULL,
  "gameOrTopic" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "editorialGoal" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "defaultCta" TEXT NOT NULL,
  "restrictions" JSONB NOT NULL,
  "operatorNotes" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceEditorialContextRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceEditorialContextRevision_revision_check" CHECK ("revision" > 0 AND "sourceVersion" > 0 AND "creatorProfileRevisionNo" > 0),
  CONSTRAINT "SourceEditorialContextRevision_restrictions_check" CHECK (jsonb_typeof("restrictions") = 'array')
);

CREATE TABLE "CutEditorialPrompt" (
  "id" UUID NOT NULL,
  "cutPipelineJobId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "cutResultArtifactId" UUID NOT NULL,
  "cutResultSha256" TEXT NOT NULL,
  "cutResultSizeBytes" BIGINT NOT NULL,
  "currentRevision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CutEditorialPrompt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CutEditorialPrompt_lineage_check" CHECK ("sourceVersion" > 0 AND "currentRevision" > 0 AND "cutResultSizeBytes" > 0 AND "cutResultSha256" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "CutEditorialPromptRevision" (
  "id" UUID NOT NULL,
  "promptId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "sourceContextId" UUID NOT NULL,
  "sourceContextRevisionId" UUID NOT NULL,
  "sourceContextRevisionNo" INTEGER NOT NULL,
  "whatHappens" TEXT NOT NULL,
  "desiredAngle" TEXT NOT NULL,
  "tone" TEXT NOT NULL,
  "cta" TEXT NOT NULL,
  "restrictions" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CutEditorialPromptRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CutEditorialPromptRevision_revision_check" CHECK ("revision" > 0 AND "sourceVersion" > 0 AND "sourceContextRevisionNo" > 0),
  CONSTRAINT "CutEditorialPromptRevision_restrictions_check" CHECK (jsonb_typeof("restrictions") = 'array')
);

CREATE TABLE "AiContentOperationRequest" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "operation" "AiContentOperationType" NOT NULL,
  "canonicalRequestVersion" TEXT NOT NULL DEFAULT 'ai-content-operation-v1',
  "canonicalRequestFingerprint" TEXT NOT NULL,
  "resolvedProjectId" UUID,
  "resolvedSourceId" UUID,
  "resolvedSourceVersion" INTEGER,
  "creatorProfileId" UUID,
  "referenceAssetId" UUID,
  "resultType" TEXT NOT NULL,
  "resultId" UUID NOT NULL,
  "resultRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiContentOperationRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiContentOperationRequest_contract_check" CHECK (
    "canonicalRequestVersion" = 'ai-content-operation-v1' AND
    "canonicalRequestFingerprint" ~ '^[a-f0-9]{64}$' AND
    ("resultRevision" IS NULL OR "resultRevision" > 0) AND
    (("resolvedProjectId" IS NULL AND "resolvedSourceId" IS NULL AND "resolvedSourceVersion" IS NULL) OR ("resolvedProjectId" IS NOT NULL AND "resolvedSourceId" IS NOT NULL AND "resolvedSourceVersion" IS NOT NULL AND "resolvedSourceVersion" > 0))
  )
);

CREATE TABLE "EditorialComponentProvenance" (
  "id" UUID NOT NULL,
  "packageRevisionId" UUID NOT NULL,
  "component" "EditorialComponentType" NOT NULL,
  "mode" "EditorialProvenanceMode" NOT NULL DEFAULT 'MANUAL',
  "basisVersion" TEXT NOT NULL DEFAULT 'manual-editorial-v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialComponentProvenance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EditorialComponentProvenance_basis_check" CHECK (length(trim("basisVersion")) > 0)
);

CREATE INDEX "CreatorProfile_updatedAt_id_idx" ON "CreatorProfile"("updatedAt", "id");
CREATE UNIQUE INDEX "VideoSource_ai_exact_source_key" ON "VideoSource"("id", "projectId", "sourceVersion");
CREATE INDEX "CreatorProfileOfficialUrlIdentity_owner_page_idx" ON "CreatorProfileOfficialUrlIdentity"("creatorProfileId", "createdAt", "id");
CREATE UNIQUE INDEX "CreatorProfileOfficialUrlIdentity_semantic_url_key" ON "CreatorProfileOfficialUrlIdentity"("canonicalizationVersion", "canonicalUrl");
CREATE UNIQUE INDEX "CreatorProfileOfficialUrlIdentity_owner_key" ON "CreatorProfileOfficialUrlIdentity"("id", "creatorProfileId");
CREATE INDEX "CreatorProfileRevision_officialUrlIdentityId_idx" ON "CreatorProfileRevision"("officialUrlIdentityId");
CREATE INDEX "CreatorProfileRevision_defaultReferenceAssetId_idx" ON "CreatorProfileRevision"("defaultReferenceAssetId");
CREATE UNIQUE INDEX "CreatorProfileRevision_profile_revision_key" ON "CreatorProfileRevision"("creatorProfileId", "revision");
CREATE UNIQUE INDEX "CreatorProfileRevision_exact_identity_key" ON "CreatorProfileRevision"("id", "creatorProfileId", "revision");
CREATE UNIQUE INDEX "CreatorReferenceAsset_objectKey_key" ON "CreatorReferenceAsset"("objectKey");
CREATE INDEX "CreatorReferenceAsset_creatorProfileId_createdAt_id_idx" ON "CreatorReferenceAsset"("creatorProfileId", "createdAt", "id");
CREATE INDEX "CreatorReferenceAsset_cleanupStatus_updatedAt_idx" ON "CreatorReferenceAsset"("cleanupStatus", "updatedAt");
CREATE UNIQUE INDEX "CreatorReferenceAsset_owner_key" ON "CreatorReferenceAsset"("id", "creatorProfileId");
CREATE INDEX "CreatorReferenceAuthorization_asset_page_idx" ON "CreatorReferenceAuthorizationRevision"("referenceAssetId", "createdAt", "id");
CREATE UNIQUE INDEX "CreatorReferenceAuthorizationRevision_asset_revision_key" ON "CreatorReferenceAuthorizationRevision"("referenceAssetId", "revision");
CREATE UNIQUE INDEX "CreatorReferenceAuthorizationRevision_exact_identity_key" ON "CreatorReferenceAuthorizationRevision"("id", "referenceAssetId", "revision");
CREATE INDEX "SourceEditorialContext_projectId_updatedAt_id_idx" ON "SourceEditorialContext"("projectId", "updatedAt", "id");
CREATE UNIQUE INDEX "SourceEditorialContext_exact_source_version_key" ON "SourceEditorialContext"("projectId", "sourceId", "sourceVersion");
CREATE UNIQUE INDEX "SourceEditorialContext_exact_identity_key" ON "SourceEditorialContext"("id", "projectId", "sourceId", "sourceVersion");
CREATE INDEX "SourceEditorialContextRevision_creatorProfileRevisionId_idx" ON "SourceEditorialContextRevision"("creatorProfileRevisionId");
CREATE UNIQUE INDEX "SourceEditorialContextRevision_context_revision_key" ON "SourceEditorialContextRevision"("contextId", "revision");
CREATE UNIQUE INDEX "SourceEditorialContextRevision_exact_identity_key" ON "SourceEditorialContextRevision"("id", "contextId", "revision");
CREATE UNIQUE INDEX "SourceEditorialContextRevision_lineage_key" ON "SourceEditorialContextRevision"("id", "contextId", "revision", "projectId", "sourceId", "sourceVersion");
CREATE UNIQUE INDEX "CutEditorialPrompt_cutPipelineJobId_key" ON "CutEditorialPrompt"("cutPipelineJobId");
CREATE UNIQUE INDEX "CutEditorialPrompt_cutResultArtifactId_key" ON "CutEditorialPrompt"("cutResultArtifactId");
CREATE UNIQUE INDEX "CutEditorialPrompt_cut_job_lineage_key" ON "CutEditorialPrompt"("cutPipelineJobId", "projectId", "sourceId", "sourceVersion");
CREATE UNIQUE INDEX "CutEditorialPrompt_result_lineage_key" ON "CutEditorialPrompt"("cutResultArtifactId", "projectId", "sourceId", "sourceVersion", "cutPipelineJobId");
CREATE INDEX "CutEditorialPrompt_projectId_updatedAt_id_idx" ON "CutEditorialPrompt"("projectId", "updatedAt", "id");
CREATE UNIQUE INDEX "CutEditorialPrompt_exact_lineage_key" ON "CutEditorialPrompt"("id", "projectId", "sourceId", "sourceVersion");
CREATE INDEX "CutEditorialPromptRevision_sourceContextRevisionId_idx" ON "CutEditorialPromptRevision"("sourceContextRevisionId");
CREATE UNIQUE INDEX "CutEditorialPromptRevision_prompt_revision_key" ON "CutEditorialPromptRevision"("promptId", "revision");
CREATE UNIQUE INDEX "CutEditorialPromptRevision_exact_identity_key" ON "CutEditorialPromptRevision"("id", "promptId", "revision");
CREATE UNIQUE INDEX "AiContentOperationRequest_idempotencyKey_key" ON "AiContentOperationRequest"("idempotencyKey");
CREATE INDEX "AiContentOperationRequest_resolvedProjectId_createdAt_id_idx" ON "AiContentOperationRequest"("resolvedProjectId", "createdAt", "id");
CREATE INDEX "AiContentOperationRequest_creatorProfileId_createdAt_id_idx" ON "AiContentOperationRequest"("creatorProfileId", "createdAt", "id");
CREATE INDEX "AiContentOperationRequest_referenceAssetId_createdAt_id_idx" ON "AiContentOperationRequest"("referenceAssetId", "createdAt", "id");
CREATE INDEX "EditorialComponentProvenance_packageRevisionId_idx" ON "EditorialComponentProvenance"("packageRevisionId");
CREATE UNIQUE INDEX "EditorialComponentProvenance_revision_component_key" ON "EditorialComponentProvenance"("packageRevisionId", "component");

ALTER TABLE "CreatorProfileOfficialUrlIdentity" ADD CONSTRAINT "CreatorProfileOfficialUrlIdentity_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "CreatorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorProfileRevision" ADD CONSTRAINT "CreatorProfileRevision_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "CreatorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorProfileRevision" ADD CONSTRAINT "CreatorProfileRevision_exact_url_owner" FOREIGN KEY ("officialUrlIdentityId", "creatorProfileId") REFERENCES "CreatorProfileOfficialUrlIdentity"("id", "creatorProfileId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorProfileRevision" ADD CONSTRAINT "CreatorProfileRevision_exact_default_asset" FOREIGN KEY ("defaultReferenceAssetId", "creatorProfileId") REFERENCES "CreatorReferenceAsset"("id", "creatorProfileId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorProfileRevision" ADD CONSTRAINT "CreatorProfileRevision_exact_default_authorization" FOREIGN KEY ("defaultReferenceAuthorizationRevisionId", "defaultReferenceAssetId", "defaultReferenceAuthorizationRevision") REFERENCES "CreatorReferenceAuthorizationRevision"("id", "referenceAssetId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorReferenceAsset" ADD CONSTRAINT "CreatorReferenceAsset_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "CreatorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorReferenceAuthorizationRevision" ADD CONSTRAINT "CreatorReferenceAuthorizationRevision_referenceAssetId_fkey" FOREIGN KEY ("referenceAssetId") REFERENCES "CreatorReferenceAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceEditorialContext" ADD CONSTRAINT "SourceEditorialContext_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceEditorialContext" ADD CONSTRAINT "SourceEditorialContext_exact_source" FOREIGN KEY ("sourceId", "projectId", "sourceVersion") REFERENCES "VideoSource"("id", "projectId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceEditorialContextRevision" ADD CONSTRAINT "SourceEditorialContextRevision_exact_context" FOREIGN KEY ("contextId", "projectId", "sourceId", "sourceVersion") REFERENCES "SourceEditorialContext"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceEditorialContextRevision" ADD CONSTRAINT "SourceEditorialContextRevision_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "CreatorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceEditorialContextRevision" ADD CONSTRAINT "SourceEditorialContextRevision_exact_profile_revision" FOREIGN KEY ("creatorProfileRevisionId", "creatorProfileId", "creatorProfileRevisionNo") REFERENCES "CreatorProfileRevision"("id", "creatorProfileId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CutEditorialPrompt" ADD CONSTRAINT "CutEditorialPrompt_exact_cut_job" FOREIGN KEY ("cutPipelineJobId", "projectId", "sourceId", "sourceVersion") REFERENCES "PipelineJob"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CutEditorialPrompt" ADD CONSTRAINT "CutEditorialPrompt_exact_result_artifact" FOREIGN KEY ("cutResultArtifactId", "projectId", "sourceId", "sourceVersion", "cutPipelineJobId") REFERENCES "MediaArtifact"("id", "projectId", "lineageSourceId", "lineageSourceVersion", "pipelineJobId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CutEditorialPromptRevision" ADD CONSTRAINT "CutEditorialPromptRevision_exact_prompt" FOREIGN KEY ("promptId", "projectId", "sourceId", "sourceVersion") REFERENCES "CutEditorialPrompt"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CutEditorialPromptRevision" ADD CONSTRAINT "CutEditorialPromptRevision_exact_source_context" FOREIGN KEY ("sourceContextRevisionId", "sourceContextId", "sourceContextRevisionNo", "projectId", "sourceId", "sourceVersion") REFERENCES "SourceEditorialContextRevision"("id", "contextId", "revision", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialComponentProvenance" ADD CONSTRAINT "EditorialComponentProvenance_packageRevisionId_fkey" FOREIGN KEY ("packageRevisionId") REFERENCES "EditorialPackageRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
