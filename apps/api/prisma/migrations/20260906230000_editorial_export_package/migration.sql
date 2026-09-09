-- ADR-007 Stage 2e: immutable background editorial export packages.
-- Additive only; export admission remains disabled until independent review.
ALTER TYPE "MediaArtifactRole" ADD VALUE 'EDITORIAL_EXPORT_PACKAGE';
ALTER TYPE "PipelineJobType" ADD VALUE 'EXPORT_EDITORIAL_PACKAGE';
ALTER TYPE "AssemblyProgressPhase" ADD VALUE 'READ_INPUTS';
ALTER TYPE "AssemblyProgressPhase" ADD VALUE 'WRITE_ARCHIVE';

CREATE UNIQUE INDEX "EditorialApproval_export_snapshot_key" ON "EditorialApproval"(
  "id", "projectId", "sourceId", "sourceVersion", "cutPipelineJobId",
  "candidateFingerprint", "editorialPackageRevisionId", "recipeRevisionId",
  "assemblyRenderResultId"
);

CREATE TABLE "EditorialExportIntent" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceId" UUID NOT NULL REFERENCES "VideoSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceVersion" INTEGER NOT NULL CHECK ("sourceVersion" > 0),
  "cutPipelineJobId" UUID NOT NULL,
  "approvalId" UUID NOT NULL,
  "approvalCandidateFingerprint" TEXT NOT NULL CHECK ("approvalCandidateFingerprint" ~ '^[a-f0-9]{64}$'),
  "editorialPackageRevisionId" UUID NOT NULL REFERENCES "EditorialPackageRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recipeRevisionId" UUID NOT NULL REFERENCES "AssemblyRecipeRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "assemblyRenderResultId" UUID NOT NULL REFERENCES "AssemblyRenderResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "exportContractVersion" TEXT NOT NULL DEFAULT 'editorial-export-zip-v1'
    CHECK ("exportContractVersion" = 'editorial-export-zip-v1'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialExportIntent_exact_approval"
    FOREIGN KEY (
      "approvalId", "projectId", "sourceId", "sourceVersion", "cutPipelineJobId",
      "approvalCandidateFingerprint", "editorialPackageRevisionId", "recipeRevisionId",
      "assemblyRenderResultId"
    ) REFERENCES "EditorialApproval"(
      "id", "projectId", "sourceId", "sourceVersion", "cutPipelineJobId",
      "candidateFingerprint", "editorialPackageRevisionId", "recipeRevisionId",
      "assemblyRenderResultId"
    ) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialExportIntent_approval_contract_key" UNIQUE ("approvalId", "exportContractVersion")
);
CREATE UNIQUE INDEX "EditorialExportIntent_exact_lineage_key"
  ON "EditorialExportIntent"("id", "projectId", "sourceId", "sourceVersion");
CREATE INDEX "EditorialExportIntent_projectId_createdAt_id_idx"
  ON "EditorialExportIntent"("projectId", "createdAt", "id");

ALTER TABLE "PipelineJob" ADD COLUMN "editorialExportIntentId" UUID;
CREATE UNIQUE INDEX "PipelineJob_editorialExportIntentId_key" ON "PipelineJob"("editorialExportIntentId");
CREATE UNIQUE INDEX "PipelineJob_editorial_export_intent_lineage_key"
  ON "PipelineJob"("editorialExportIntentId", "projectId", "sourceId", "sourceVersion");
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_exact_editorial_export_intent"
  FOREIGN KEY ("editorialExportIntentId", "projectId", "sourceId", "sourceVersion")
  REFERENCES "EditorialExportIntent"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The existing type-shape guard predates the export job type and intentionally
-- enumerates every supported PipelineJob variant. Replace it atomically so the
-- new relation remains mandatory only for export jobs and forbidden elsewhere.
ALTER TABLE "PipelineJob" DROP CONSTRAINT "PipelineJob_montage_type";
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_montage_type" CHECK (
  ("type"::text = 'MONTAGE_ASSET_PROBE' AND "montageAssetId" IS NOT NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'montage-asset-probe-v1')
  OR ("type"::text = 'ASSEMBLE_HORIZONTAL' AND "assemblyRenderIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'horizontal-render-v1')
  OR ("type"::text = 'EXPORT_EDITORIAL_PACKAGE' AND "editorialExportIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'editorial-export-zip-v1')
  OR ("type"::text IN ('SOURCE_PROBE','CUT_SEGMENT') AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL)
);

CREATE TABLE "EditorialExportResult" (
  "id" UUID PRIMARY KEY,
  "exportIntentId" UUID NOT NULL UNIQUE REFERENCES "EditorialExportIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "pipelineJobId" UUID NOT NULL UNIQUE REFERENCES "PipelineJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "artifactId" UUID NOT NULL UNIQUE REFERENCES "MediaArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "filename" TEXT NOT NULL CHECK (length("filename") BETWEEN 1 AND 180),
  "archiveSizeBytes" BIGINT NOT NULL CHECK ("archiveSizeBytes" > 0),
  "archiveSha256" TEXT NOT NULL CHECK ("archiveSha256" ~ '^[a-f0-9]{64}$'),
  "manifest" JSONB NOT NULL CHECK (jsonb_typeof("manifest") = 'object'),
  "exportContractVersion" TEXT NOT NULL DEFAULT 'editorial-export-zip-v1'
    CHECK ("exportContractVersion" = 'editorial-export-zip-v1'),
  "completedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialExportResult_exact_identity_key" UNIQUE ("id", "exportIntentId", "artifactId")
);

ALTER TABLE "EditorialOperationRequest" ADD CONSTRAINT "EditorialOperationRequest_exportIntentId_fkey"
  FOREIGN KEY ("exportIntentId") REFERENCES "EditorialExportIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobAttempt" ADD COLUMN "scratchDirectoryName" TEXT;
ALTER TABLE "JobAttempt" ADD COLUMN "scratchLeaseHash" TEXT;
ALTER TABLE "JobAttempt" ADD COLUMN "scratchReservedBytes" BIGINT;
ALTER TABLE "JobAttempt" ADD COLUMN "scratchCreatedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "JobAttempt_scratchDirectoryName_key" ON "JobAttempt"("scratchDirectoryName");
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_export_scratch_shape" CHECK (
  ("scratchDirectoryName" IS NULL AND "scratchLeaseHash" IS NULL AND "scratchReservedBytes" IS NULL AND "scratchCreatedAt" IS NULL)
  OR (
    "scratchDirectoryName" IS NOT NULL AND "scratchDirectoryName" ~ '^export-[0-9a-f-]{36}-[0-9]+-[a-f0-9]{16}$'
    AND "scratchLeaseHash" ~ '^[a-f0-9]{64}$'
    AND "scratchReservedBytes" > 0
    AND "scratchCreatedAt" IS NOT NULL
  )
);
