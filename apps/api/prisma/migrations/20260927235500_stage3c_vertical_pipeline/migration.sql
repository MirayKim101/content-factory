ALTER TYPE "MediaArtifactRole" ADD VALUE 'VERTICAL_RENDER_RESULT';
ALTER TYPE "PipelineJobType" ADD VALUE 'RENDER_VERTICAL';
CREATE TYPE "VerticalFramingMode" AS ENUM ('CENTER_CROP');

CREATE TABLE "VerticalRenderIntent" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "cutPipelineJobId" UUID NOT NULL,
  "cutResultArtifactId" UUID NOT NULL,
  "framingMode" "VerticalFramingMode" NOT NULL DEFAULT 'CENTER_CROP',
  "outputWidth" INTEGER NOT NULL DEFAULT 1080,
  "outputHeight" INTEGER NOT NULL DEFAULT 1920,
  "renderContractVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VerticalRenderIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VerticalRenderIntent_dimensions_check" CHECK ("outputWidth" = 1080 AND "outputHeight" = 1920),
  CONSTRAINT "VerticalRenderIntent_contract_check" CHECK ("renderContractVersion" = 'vertical-render-v1')
);

CREATE TABLE "VerticalRenderResult" (
  "id" UUID NOT NULL,
  "intentId" UUID NOT NULL,
  "pipelineJobId" UUID NOT NULL,
  "artifactId" UUID NOT NULL,
  "renderContractVersion" TEXT NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VerticalRenderResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VerticalRenderResult_dimensions_check" CHECK ("width" = 1080 AND "height" = 1920),
  CONSTRAINT "VerticalRenderResult_duration_check" CHECK ("durationMs" > 0),
  CONSTRAINT "VerticalRenderResult_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "VerticalRenderResult_size_check" CHECK ("sizeBytes" > 0),
  CONSTRAINT "VerticalRenderResult_contract_check" CHECK ("renderContractVersion" = 'vertical-render-v1')
);

CREATE TABLE "VerticalApproval" (
  "id" UUID NOT NULL,
  "resultId" UUID NOT NULL,
  "approvalVersion" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VerticalApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VerticalApproval_version_check" CHECK ("approvalVersion" = 'human-vertical-approval-v1')
);

ALTER TABLE "PipelineJob" ADD COLUMN "verticalRenderIntentId" UUID;

CREATE UNIQUE INDEX "VerticalRenderIntent_idempotencyKey_key" ON "VerticalRenderIntent"("idempotencyKey");
CREATE UNIQUE INDEX "VerticalRenderIntent_id_projectId_sourceId_sourceVersion_key" ON "VerticalRenderIntent"("id", "projectId", "sourceId", "sourceVersion");
CREATE INDEX "VerticalRenderIntent_projectId_createdAt_id_idx" ON "VerticalRenderIntent"("projectId", "createdAt", "id");
CREATE UNIQUE INDEX "VerticalRenderResult_intentId_key" ON "VerticalRenderResult"("intentId");
CREATE UNIQUE INDEX "VerticalRenderResult_pipelineJobId_key" ON "VerticalRenderResult"("pipelineJobId");
CREATE UNIQUE INDEX "VerticalRenderResult_artifactId_key" ON "VerticalRenderResult"("artifactId");
CREATE UNIQUE INDEX "VerticalApproval_resultId_key" ON "VerticalApproval"("resultId");
CREATE UNIQUE INDEX "PipelineJob_verticalRenderIntentId_key" ON "PipelineJob"("verticalRenderIntentId");
CREATE UNIQUE INDEX "PipelineJob_vertical_intent_lineage_key" ON "PipelineJob"("verticalRenderIntentId", "projectId", "sourceId", "sourceVersion");

ALTER TABLE "VerticalRenderIntent" ADD CONSTRAINT "VerticalRenderIntent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerticalRenderIntent" ADD CONSTRAINT "VerticalRenderIntent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "VideoSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerticalRenderIntent" ADD CONSTRAINT "VerticalRenderIntent_exact_cut_job" FOREIGN KEY ("cutPipelineJobId", "projectId", "sourceId", "sourceVersion") REFERENCES "PipelineJob"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerticalRenderIntent" ADD CONSTRAINT "VerticalRenderIntent_exact_cut_artifact" FOREIGN KEY ("cutResultArtifactId", "projectId", "sourceId", "sourceVersion", "cutPipelineJobId") REFERENCES "MediaArtifact"("id", "projectId", "lineageSourceId", "lineageSourceVersion", "pipelineJobId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_exact_vertical_intent" FOREIGN KEY ("verticalRenderIntentId", "projectId", "sourceId", "sourceVersion") REFERENCES "VerticalRenderIntent"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerticalRenderResult" ADD CONSTRAINT "VerticalRenderResult_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "VerticalRenderIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerticalRenderResult" ADD CONSTRAINT "VerticalRenderResult_pipelineJobId_fkey" FOREIGN KEY ("pipelineJobId") REFERENCES "PipelineJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerticalRenderResult" ADD CONSTRAINT "VerticalRenderResult_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "MediaArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerticalApproval" ADD CONSTRAINT "VerticalApproval_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "VerticalRenderResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
