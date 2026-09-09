-- ADR-005 additive only. Deploy after old workers drain; never reset user data.
ALTER TYPE "PipelineJobType" ADD VALUE 'MONTAGE_ASSET_PROBE';
CREATE TYPE "MontageAssetKind" AS ENUM ('ADVERTISEMENT', 'INTRO', 'OUTRO', 'BANNER');
CREATE TYPE "MontageAssetStatus" AS ENUM ('UPLOADING', 'PROBE_PENDING', 'READY', 'FAILED_FINAL');
CREATE TABLE "MontageAsset" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceId" UUID NOT NULL REFERENCES "VideoSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceVersion" INTEGER NOT NULL CHECK ("sourceVersion" > 0),
  "kind" "MontageAssetKind" NOT NULL,
  "status" "MontageAssetStatus" NOT NULL DEFAULT 'UPLOADING',
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestFingerprint" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL UNIQUE,
  "originalFilename" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL CHECK ("sizeBytes" > 0),
  "sha256" TEXT NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "width" INTEGER,
  "height" INTEGER,
  "durationMs" INTEGER,
  "hasAudio" BOOLEAN,
  "probeVersion" TEXT,
  "probedAt" TIMESTAMP(3),
  "rightsBasis" TEXT NOT NULL CHECK ("rightsBasis" = 'LOCAL_DEVELOPMENT_AUTO'),
  "rightsDeclaration" TEXT NOT NULL CHECK ("rightsDeclaration" = 'montage-local-development-auto-v1'),
  "rightsDecidedAt" TIMESTAMP(3) NOT NULL,
  "uploadExpiresAt" TIMESTAMP(3) NOT NULL,
  "storageEtag" TEXT,
  "storageVersion" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "cleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "cleanupLastErrorCode" TEXT,
  "cleanupCompletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MontageAsset_kind_limits" CHECK (
    ("kind" = 'BANNER' AND "contentType" IN ('image/png','image/jpeg','image/webp') AND "sizeBytes" <= 10485760 AND "width" IS NOT NULL AND "height" IS NOT NULL AND "width" > 0 AND "height" > 0 AND "width"::bigint * "height" <= 40000000 AND "durationMs" IS NULL AND "hasAudio" IS NULL)
    OR ("kind" <> 'BANNER' AND "contentType" = 'video/mp4' AND "sizeBytes" <= 268435456)
  ),
  CONSTRAINT "MontageAsset_ready_video" CHECK ("status" <> 'READY' OR "kind" = 'BANNER' OR
    ("durationMs" IS NOT NULL AND "durationMs" BETWEEN 1 AND 180000 AND "width" IS NOT NULL AND "width" BETWEEN 1 AND 3840 AND "height" IS NOT NULL AND "height" BETWEEN 1 AND 2160 AND "hasAudio" IS NOT NULL AND "probeVersion" IS NOT NULL AND "probedAt" IS NOT NULL)),
  CONSTRAINT "MontageAsset_cleanup_terminal" CHECK ("cleanupStatus" = 'NOT_REQUIRED' OR "status" = 'FAILED_FINAL'),
  CONSTRAINT "MontageAsset_failed_error" CHECK ("status" <> 'FAILED_FINAL' OR ("failureCode" IS NOT NULL AND "failureMessage" IS NOT NULL))
);
CREATE UNIQUE INDEX "MontageAsset_id_projectId_sourceId_sourceVersion_key" ON "MontageAsset"("id","projectId","sourceId","sourceVersion");
CREATE INDEX "MontageAsset_projectId_kind_createdAt_id_idx" ON "MontageAsset"("projectId","kind","createdAt","id");
CREATE INDEX "MontageAsset_status_uploadExpiresAt_idx" ON "MontageAsset"("status","uploadExpiresAt");
CREATE INDEX "MontageAsset_cleanupStatus_updatedAt_idx" ON "MontageAsset"("cleanupStatus","updatedAt");
CREATE UNIQUE INDEX "VideoSource_id_projectId_key" ON "VideoSource"("id","projectId");
ALTER TABLE "MontageAsset" ADD CONSTRAINT "MontageAsset_exact_project_source" FOREIGN KEY ("sourceId","projectId") REFERENCES "VideoSource"("id","projectId") ON DELETE RESTRICT;
ALTER TABLE "PipelineJob" ADD COLUMN "montageAssetId" UUID;
CREATE UNIQUE INDEX "PipelineJob_montageAssetId_key" ON "PipelineJob"("montageAssetId");
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_montageAssetId_fkey" FOREIGN KEY ("montageAssetId") REFERENCES "MontageAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_montage_exact_lineage" FOREIGN KEY ("montageAssetId","projectId","sourceId","sourceVersion") REFERENCES "MontageAsset"("id","projectId","sourceId","sourceVersion") ON DELETE RESTRICT;
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_montage_type" CHECK (
  ("type"::text = 'MONTAGE_ASSET_PROBE' AND "montageAssetId" IS NOT NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'montage-asset-probe-v1')
  OR ("type"::text IN ('SOURCE_PROBE','CUT_SEGMENT') AND "montageAssetId" IS NULL)
);
