-- ADR-006 Stage 2c: durable exact-revision horizontal assembly render.
-- Additive only; deploy the capable worker before enabling API admission.
ALTER TYPE "PipelineJobType" ADD VALUE 'ASSEMBLE_HORIZONTAL';
ALTER TYPE "MediaArtifactRole" ADD VALUE 'HORIZONTAL_ASSEMBLY_RESULT';
CREATE TYPE "AssemblyProgressPhase" AS ENUM (
  'DOWNLOAD', 'AUDIO_ANALYSIS', 'ENCODE', 'OUTPUT_PROBE',
  'OUTPUT_HASH', 'UPLOAD', 'FINALIZE'
);

ALTER TABLE "PipelineJob"
  ADD COLUMN "assemblyRenderIntentId" UUID,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "admissionReason" TEXT,
  ADD COLUMN "progressAttemptNumber" INTEGER,
  ADD COLUMN "progressPhase" "AssemblyProgressPhase",
  ADD COLUMN "progressBasisPoints" INTEGER,
  ADD COLUMN "progressUpdatedAt" TIMESTAMP(3);

CREATE TABLE "AssemblyRenderIntent" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceId" UUID NOT NULL REFERENCES "VideoSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceVersion" INTEGER NOT NULL CHECK ("sourceVersion" > 0),
  "cutPipelineJobId" UUID NOT NULL,
  "cutResultArtifactId" UUID NOT NULL,
  "cutResultSha256" TEXT NOT NULL CHECK ("cutResultSha256" ~ '^[a-f0-9]{64}$'),
  "cutResultSizeBytes" BIGINT NOT NULL CHECK ("cutResultSizeBytes" > 0),
  "cutResultRecipeVersion" TEXT NOT NULL,
  "assemblyRecipeId" UUID NOT NULL REFERENCES "AssemblyRecipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recipeRevisionId" UUID NOT NULL,
  "recipeRevision" INTEGER NOT NULL CHECK ("recipeRevision" > 0),
  "configurationFingerprint" TEXT NOT NULL CHECK ("configurationFingerprint" ~ '^[a-f0-9]{64}$'),
  "renderContractVersion" TEXT NOT NULL DEFAULT 'horizontal-render-v1' CHECK ("renderContractVersion" = 'horizontal-render-v1'),
  "audioProfileVersion" TEXT NOT NULL CHECK ("audioProfileVersion" = 'youtube-stereo-v1'),
  "encodingProfileVersion" TEXT NOT NULL CHECK ("encodingProfileVersion" = 'youtube-h264-v1'),
  "expectedDurationMs" INTEGER NOT NULL CHECK ("expectedDurationMs" > 0 AND "expectedDurationMs" <= 43200000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssemblyRenderIntent_revision_contract_key" UNIQUE ("recipeRevisionId", "renderContractVersion")
);
CREATE UNIQUE INDEX "AssemblyRenderIntent_exact_lineage_key" ON "AssemblyRenderIntent"("id", "projectId", "sourceId", "sourceVersion");
CREATE INDEX "AssemblyRenderIntent_projectId_createdAt_id_idx" ON "AssemblyRenderIntent"("projectId", "createdAt", "id");
CREATE UNIQUE INDEX "AssemblyRecipeRevision_exact_identity_key" ON "AssemblyRecipeRevision"("id", "recipeId", "revision");
ALTER TABLE "AssemblyRenderIntent" ADD CONSTRAINT "AssemblyRenderIntent_exact_recipe_revision"
  FOREIGN KEY ("recipeRevisionId", "assemblyRecipeId", "recipeRevision")
  REFERENCES "AssemblyRecipeRevision"("id", "recipeId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssemblyRenderIntent" ADD CONSTRAINT "AssemblyRenderIntent_exact_cut_job"
  FOREIGN KEY ("cutPipelineJobId", "projectId", "sourceId", "sourceVersion")
  REFERENCES "PipelineJob"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssemblyRenderIntent" ADD CONSTRAINT "AssemblyRenderIntent_exact_cut_artifact"
  FOREIGN KEY ("cutResultArtifactId", "projectId", "sourceId", "sourceVersion", "cutPipelineJobId")
  REFERENCES "MediaArtifact"("id", "projectId", "lineageSourceId", "lineageSourceVersion", "pipelineJobId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AssemblyRenderRequest" (
  "id" UUID PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestFingerprint" TEXT NOT NULL CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  "renderIntentId" UUID NOT NULL REFERENCES "AssemblyRenderIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AssemblyRenderResult" (
  "id" UUID PRIMARY KEY,
  "renderIntentId" UUID NOT NULL UNIQUE REFERENCES "AssemblyRenderIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "artifactId" UUID NOT NULL UNIQUE REFERENCES "MediaArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "durationMs" INTEGER NOT NULL CHECK ("durationMs" > 0),
  "width" INTEGER NOT NULL CHECK ("width" BETWEEN 1 AND 3840),
  "height" INTEGER NOT NULL CHECK ("height" BETWEEN 1 AND 2160),
  "fpsNumerator" INTEGER NOT NULL CHECK ("fpsNumerator" > 0),
  "fpsDenominator" INTEGER NOT NULL CHECK ("fpsDenominator" > 0),
  "videoCodec" TEXT NOT NULL CHECK ("videoCodec" = 'h264'),
  "pixelFormat" TEXT NOT NULL CHECK ("pixelFormat" = 'yuv420p'),
  "audioCodec" TEXT NOT NULL CHECK ("audioCodec" = 'aac'),
  "audioSampleRate" INTEGER NOT NULL CHECK ("audioSampleRate" = 48000),
  "audioChannels" INTEGER NOT NULL CHECK ("audioChannels" = 2),
  "ffmpegVersion" TEXT NOT NULL,
  "ffprobeVersion" TEXT NOT NULL,
  "integratedLoudnessLufs" DOUBLE PRECISION,
  "truePeakDbtp" DOUBLE PRECISION,
  "normalizationProfileResult" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssemblyRenderResult_loudness_finite" CHECK (
    ("integratedLoudnessLufs" IS NULL OR "integratedLoudnessLufs" BETWEEN -100 AND 10)
    AND ("truePeakDbtp" IS NULL OR "truePeakDbtp" BETWEEN -100 AND 10)
  )
);

CREATE UNIQUE INDEX "PipelineJob_assemblyRenderIntentId_key" ON "PipelineJob"("assemblyRenderIntentId");
CREATE UNIQUE INDEX "PipelineJob_assembly_intent_lineage_key" ON "PipelineJob"("assemblyRenderIntentId", "projectId", "sourceId", "sourceVersion");
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_exact_assembly_intent"
  FOREIGN KEY ("assemblyRenderIntentId", "projectId", "sourceId", "sourceVersion")
  REFERENCES "AssemblyRenderIntent"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_assembly_progress" CHECK (
  ("progressAttemptNumber" IS NULL AND "progressPhase" IS NULL AND "progressBasisPoints" IS NULL AND "progressUpdatedAt" IS NULL)
  OR ("progressAttemptNumber" IS NOT NULL AND "progressAttemptNumber" > 0 AND "progressPhase" IS NOT NULL
      AND "progressBasisPoints" BETWEEN 0 AND 10000 AND "progressUpdatedAt" IS NOT NULL)
);
UPDATE "PipelineJob" SET "nextAttemptAt" = COALESCE("updatedAt", now()) WHERE "state" = 'RETRY_WAIT' AND "nextAttemptAt" IS NULL;
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_retry_schedule" CHECK (
  ("state" = 'RETRY_WAIT' AND "nextAttemptAt" IS NOT NULL)
  OR ("state" = 'QUEUED')
  OR ("state" NOT IN ('QUEUED','RETRY_WAIT') AND "nextAttemptAt" IS NULL)
);
ALTER TABLE "PipelineJob" DROP CONSTRAINT "PipelineJob_montage_type";
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_montage_type" CHECK (
  ("type"::text = 'MONTAGE_ASSET_PROBE' AND "montageAssetId" IS NOT NULL AND "assemblyRenderIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'montage-asset-probe-v1')
  OR ("type"::text = 'ASSEMBLE_HORIZONTAL' AND "assemblyRenderIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'horizontal-render-v1')
  OR ("type"::text IN ('SOURCE_PROBE','CUT_SEGMENT') AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL)
);
