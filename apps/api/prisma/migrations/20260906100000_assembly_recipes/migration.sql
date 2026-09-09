-- ADR-005 Stage 2b: immutable assembly recipe configuration only.
CREATE TYPE "AssemblyAssetRole" AS ENUM ('INTRO', 'OUTRO', 'ADVERTISEMENT', 'BANNER');
CREATE TYPE "AssemblyOverlayPosition" AS ENUM ('TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT');

CREATE TABLE "AssemblyRecipe" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "pipelineJobId" UUID NOT NULL UNIQUE,
  "cutResultArtifactId" UUID NOT NULL UNIQUE,
  "cutResultSha256" TEXT NOT NULL CHECK ("cutResultSha256" ~ '^[a-f0-9]{64}$'),
  "cutResultSizeBytes" BIGINT NOT NULL CHECK ("cutResultSizeBytes" > 0),
  "cutResultRecipeVersion" TEXT NOT NULL,
  "lineageSourceId" UUID NOT NULL,
  "lineageSourceVersion" INTEGER NOT NULL CHECK ("lineageSourceVersion" > 0),
  "cutDurationMs" INTEGER NOT NULL CHECK ("cutDurationMs" > 0),
  "currentRevision" INTEGER NOT NULL CHECK ("currentRevision" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AssemblyRecipe_projectId_updatedAt_id_idx" ON "AssemblyRecipe"("projectId", "updatedAt", "id");
CREATE UNIQUE INDEX "AssemblyRecipe_pipeline_exact_key" ON "AssemblyRecipe"("pipelineJobId", "projectId", "lineageSourceId", "lineageSourceVersion");
CREATE UNIQUE INDEX "AssemblyRecipe_artifact_exact_key" ON "AssemblyRecipe"("cutResultArtifactId", "projectId", "lineageSourceId", "lineageSourceVersion", "pipelineJobId");
CREATE UNIQUE INDEX "PipelineJob_id_projectId_sourceId_sourceVersion_key" ON "PipelineJob"("id", "projectId", "sourceId", "sourceVersion");
CREATE UNIQUE INDEX "MediaArtifact_id_projectId_lineage_pipelineJob_key" ON "MediaArtifact"("id", "projectId", "lineageSourceId", "lineageSourceVersion", "pipelineJobId");
ALTER TABLE "AssemblyRecipe" ADD CONSTRAINT "AssemblyRecipe_exact_job_lineage" FOREIGN KEY ("pipelineJobId", "projectId", "lineageSourceId", "lineageSourceVersion") REFERENCES "PipelineJob"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssemblyRecipe" ADD CONSTRAINT "AssemblyRecipe_exact_artifact_lineage" FOREIGN KEY ("cutResultArtifactId", "projectId", "lineageSourceId", "lineageSourceVersion", "pipelineJobId") REFERENCES "MediaArtifact"("id", "projectId", "lineageSourceId", "lineageSourceVersion", "pipelineJobId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AssemblyRecipeRevision" (
  "id" UUID PRIMARY KEY,
  "recipeId" UUID NOT NULL REFERENCES "AssemblyRecipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "schemaVersion" TEXT NOT NULL DEFAULT 'horizontal-assembly-v1' CHECK ("schemaVersion" = 'horizontal-assembly-v1'),
  "configurationFingerprint" TEXT NOT NULL CHECK ("configurationFingerprint" ~ '^[a-f0-9]{64}$'),
  "audioProfileVersion" TEXT NOT NULL DEFAULT 'youtube-stereo-v1' CHECK ("audioProfileVersion" = 'youtube-stereo-v1'),
  "encodingProfileVersion" TEXT NOT NULL DEFAULT 'youtube-h264-v1' CHECK ("encodingProfileVersion" = 'youtube-h264-v1'),
  "advertisementInsertAtMs" INTEGER,
  "ctaText" TEXT,
  "ctaStartMs" INTEGER,
  "ctaEndMs" INTEGER,
  "ctaPosition" "AssemblyOverlayPosition",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssemblyRecipeRevision_recipe_revision_key" UNIQUE ("recipeId", "revision"),
  CONSTRAINT "AssemblyRecipeRevision_cta_shape" CHECK (
    ("ctaText" IS NULL AND "ctaStartMs" IS NULL AND "ctaEndMs" IS NULL AND "ctaPosition" IS NULL)
    OR ("ctaText" IS NOT NULL AND length(btrim("ctaText")) BETWEEN 1 AND 120 AND "ctaStartMs" IS NOT NULL AND "ctaEndMs" IS NOT NULL AND "ctaPosition" IS NOT NULL AND "ctaStartMs" >= 0 AND "ctaEndMs" > "ctaStartMs")
  ),
  CONSTRAINT "AssemblyRecipeRevision_ad_time" CHECK ("advertisementInsertAtMs" IS NULL OR "advertisementInsertAtMs" > 0)
);
CREATE INDEX "AssemblyRecipeRevision_createdAt_id_idx" ON "AssemblyRecipeRevision"("createdAt", "id");

CREATE TABLE "AssemblyRecipeAssetReference" (
  "id" UUID PRIMARY KEY,
  "recipeRevisionId" UUID NOT NULL REFERENCES "AssemblyRecipeRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "role" "AssemblyAssetRole" NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "assetId" UUID NOT NULL REFERENCES "MontageAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "assetRevision" INTEGER NOT NULL CHECK ("assetRevision" > 0),
  "assetSha256" TEXT NOT NULL CHECK ("assetSha256" ~ '^[a-f0-9]{64}$'),
  "assetSizeBytes" BIGINT NOT NULL CHECK ("assetSizeBytes" > 0),
  "assetKind" "MontageAssetKind" NOT NULL,
  "assetDurationMs" INTEGER,
  "clientItemId" TEXT,
  "startMs" INTEGER,
  "endMs" INTEGER,
  "position" "AssemblyOverlayPosition",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssemblyRecipeAssetReference_role_ordinal_key" UNIQUE ("recipeRevisionId", "role", "ordinal"),
  CONSTRAINT "AssemblyRecipeAssetReference_role_shape" CHECK (
    ("role" = 'INTRO' AND "ordinal" = 0 AND "assetKind" = 'INTRO' AND "assetDurationMs" IS NOT NULL AND "assetDurationMs" > 0 AND "clientItemId" IS NULL AND "startMs" IS NULL AND "endMs" IS NULL AND "position" IS NULL)
    OR ("role" = 'OUTRO' AND "ordinal" = 0 AND "assetKind" = 'OUTRO' AND "assetDurationMs" IS NOT NULL AND "assetDurationMs" > 0 AND "clientItemId" IS NULL AND "startMs" IS NULL AND "endMs" IS NULL AND "position" IS NULL)
    OR ("role" = 'ADVERTISEMENT' AND "ordinal" = 0 AND "assetKind" = 'ADVERTISEMENT' AND "assetDurationMs" IS NOT NULL AND "assetDurationMs" > 0 AND "clientItemId" IS NULL AND "startMs" IS NULL AND "endMs" IS NULL AND "position" IS NULL)
    OR ("role" = 'BANNER' AND "ordinal" BETWEEN 0 AND 7 AND "assetKind" = 'BANNER' AND "assetDurationMs" IS NULL AND "clientItemId" IS NOT NULL AND length(btrim("clientItemId")) BETWEEN 1 AND 100 AND "startMs" IS NOT NULL AND "startMs" >= 0 AND "endMs" IS NOT NULL AND "endMs" > "startMs" AND "position" IS NOT NULL)
  )
);
CREATE INDEX "AssemblyRecipeAssetReference_assetId_idx" ON "AssemblyRecipeAssetReference"("assetId");

CREATE TABLE "AssemblyRecipeMutationRequest" (
  "id" UUID PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestFingerprint" TEXT NOT NULL CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  "recipeRevisionId" UUID NOT NULL REFERENCES "AssemblyRecipeRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
