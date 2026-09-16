-- AlterEnum
ALTER TYPE "PipelineJobType" ADD VALUE 'EXTRACT_EDITORIAL_FRAMES';

-- AlterEnum
ALTER TYPE "AiContentOperationType" ADD VALUE 'CREATE_FRAME_EVIDENCE';

-- CreateTable
CREATE TABLE "FrameEvidenceIntent" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "pipelineJobId" UUID NOT NULL,
    "cutPipelineJobId" UUID NOT NULL,
    "cutResultArtifactId" UUID NOT NULL,
    "cutResultSha256" TEXT NOT NULL,
    "cutResultSizeBytes" BIGINT NOT NULL,
    "cutStartMs" INTEGER NOT NULL,
    "cutEndMs" INTEGER NOT NULL,
    "contractDurationMs" INTEGER NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "sourceAuthorizationRevision" INTEGER NOT NULL,
    "sourceAuthorizationBasis" "SourceAuthorizationBasis" NOT NULL,
    "sourceAuthorizationDeclarationVersion" TEXT NOT NULL,
    "sourceAuthorizationDecidedAt" TIMESTAMP(3) NOT NULL,
    "creatorProfileId" UUID NOT NULL,
    "creatorProfileRevisionId" UUID NOT NULL,
    "creatorProfileRevisionNo" INTEGER NOT NULL,
    "sourceContextId" UUID NOT NULL,
    "sourceContextRevisionId" UUID NOT NULL,
    "sourceContextRevisionNo" INTEGER NOT NULL,
    "cutPromptId" UUID NOT NULL,
    "cutPromptRevisionId" UUID NOT NULL,
    "cutPromptRevisionNo" INTEGER NOT NULL,
    "contextPolicyFingerprint" TEXT NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "recipeVersion" TEXT NOT NULL,
    "requestedPositionsMs" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrameEvidenceIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameExtractionPool" (
    "resourceClass" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrameExtractionPool_pkey" PRIMARY KEY ("resourceClass")
);

-- CreateTable
CREATE TABLE "FrameExtractionSlot" (
    "resourceClass" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "attemptId" UUID,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "workDeadlineAt" TIMESTAMP(3),

    CONSTRAINT "FrameExtractionSlot_pkey" PRIMARY KEY ("resourceClass","ordinal")
);

-- CreateTable
CREATE TABLE "FrameEvidenceAttempt" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "pipelineJobId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "workDeadlineAt" TIMESTAMP(3) NOT NULL,
    "inputReadStartedAt" TIMESTAMP(3),
    "inputReadFingerprint" TEXT,
    "executionStoppedAt" TIMESTAMP(3),
    "progressPhase" TEXT NOT NULL DEFAULT 'READ_INPUT',
    "completedFrameCount" INTEGER NOT NULL DEFAULT 0,
    "progressBasisPoints" INTEGER NOT NULL DEFAULT 0,
    "progressUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scratchDirectoryName" TEXT NOT NULL,
    "scratchReservedBytes" BIGINT NOT NULL,
    "scratchCleanedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrameEvidenceAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameEvidenceAttemptOutput" (
    "uploadStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadSettledAt" TIMESTAMP(3),
    "nextCleanupAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREPARED',
    "measurement" JSONB,
    "cleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'PENDING',
    "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "cleanupLastErrorCode" TEXT,
    "cleanupRequestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleanupCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FrameEvidenceAttemptOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameEvidenceResult" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrameEvidenceResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameEvidenceFrame" (
    "id" UUID NOT NULL,
    "resultId" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "outputId" UUID NOT NULL,
    "measurement" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FrameEvidenceFrame_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceIntent_pipelineJobId_key" ON "FrameEvidenceIntent"("pipelineJobId");

-- CreateIndex
CREATE INDEX "FrameEvidenceIntent_cutPipelineJobId_createdAt_id_idx" ON "FrameEvidenceIntent"("cutPipelineJobId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceIntent_id_pipelineJobId_key" ON "FrameEvidenceIntent"("id", "pipelineJobId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceIntent_pipelineJobId_projectId_sourceId_source_key" ON "FrameEvidenceIntent"("pipelineJobId", "projectId", "sourceId", "sourceVersion");

-- CreateIndex
CREATE UNIQUE INDEX "FrameExtractionSlot_attemptId_key" ON "FrameExtractionSlot"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameExtractionSlot_leaseToken_key" ON "FrameExtractionSlot"("leaseToken");

-- CreateIndex
CREATE UNIQUE INDEX "FrameExtractionSlot_attemptId_leaseToken_workDeadlineAt_key" ON "FrameExtractionSlot"("attemptId", "leaseToken", "workDeadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttempt_leaseToken_key" ON "FrameEvidenceAttempt"("leaseToken");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttempt_scratchDirectoryName_key" ON "FrameEvidenceAttempt"("scratchDirectoryName");

-- CreateIndex
CREATE INDEX "FrameEvidenceAttempt_workDeadlineAt_executionStoppedAt_idx" ON "FrameEvidenceAttempt"("workDeadlineAt", "executionStoppedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttempt_intentId_attemptNumber_key" ON "FrameEvidenceAttempt"("intentId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttempt_id_pipelineJobId_attemptNumber_leaseTo_key" ON "FrameEvidenceAttempt"("id", "pipelineJobId", "attemptNumber", "leaseToken");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttempt_id_intentId_key" ON "FrameEvidenceAttempt"("id", "intentId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttempt_id_intentId_attemptNumber_key" ON "FrameEvidenceAttempt"("id", "intentId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttempt_id_leaseToken_workDeadlineAt_key" ON "FrameEvidenceAttempt"("id", "leaseToken", "workDeadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttemptOutput_objectKey_key" ON "FrameEvidenceAttemptOutput"("objectKey");

-- CreateIndex
CREATE INDEX "FrameEvidenceAttemptOutput_cleanupStatus_updatedAt_idx" ON "FrameEvidenceAttemptOutput"("cleanupStatus", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttemptOutput_attemptId_ordinal_key" ON "FrameEvidenceAttemptOutput"("attemptId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceAttemptOutput_id_attemptId_intentId_ordinal_key" ON "FrameEvidenceAttemptOutput"("id", "attemptId", "intentId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceResult_intentId_key" ON "FrameEvidenceResult"("intentId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceResult_attemptId_key" ON "FrameEvidenceResult"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceResult_id_intentId_attemptId_key" ON "FrameEvidenceResult"("id", "intentId", "attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceResult_attemptId_intentId_key" ON "FrameEvidenceResult"("attemptId", "intentId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceFrame_outputId_key" ON "FrameEvidenceFrame"("outputId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceFrame_intentId_ordinal_key" ON "FrameEvidenceFrame"("intentId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "FrameEvidenceFrame_outputId_attemptId_intentId_ordinal_key" ON "FrameEvidenceFrame"("outputId", "attemptId", "intentId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "JobAttempt_id_jobId_attemptNumber_leaseToken_key" ON "JobAttempt"("id", "jobId", "attemptNumber", "leaseToken");

-- CreateIndex
CREATE UNIQUE INDEX "SourceContextRevision_frame_chain_key" ON "SourceEditorialContextRevision"("id", "contextId", "revision", "projectId", "sourceId", "sourceVersion", "creatorProfileId", "creatorProfileRevisionId", "creatorProfileRevisionNo");

-- CreateIndex
CREATE UNIQUE INDEX "CutPrompt_frame_chain_key" ON "CutEditorialPrompt"("id", "cutPipelineJobId", "cutResultArtifactId", "projectId", "sourceId", "sourceVersion");

-- CreateIndex
CREATE UNIQUE INDEX "CutPromptRevision_frame_chain_key" ON "CutEditorialPromptRevision"("id", "promptId", "revision", "projectId", "sourceId", "sourceVersion", "sourceContextId", "sourceContextRevisionId", "sourceContextRevisionNo");

-- AddForeignKey
ALTER TABLE "FrameEvidenceIntent" ADD CONSTRAINT "FrameEvidenceIntent_pipelineJobId_projectId_sourceId_sourc_fkey" FOREIGN KEY ("pipelineJobId", "projectId", "sourceId", "sourceVersion") REFERENCES "PipelineJob"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceIntent" ADD CONSTRAINT "FrameEvidenceIntent_cutPipelineJobId_projectId_sourceId_so_fkey" FOREIGN KEY ("cutPipelineJobId", "projectId", "sourceId", "sourceVersion") REFERENCES "PipelineJob"("id", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceIntent" ADD CONSTRAINT "FrameEvidenceIntent_exact_cut_result" FOREIGN KEY ("cutResultArtifactId", "projectId", "sourceId", "sourceVersion", "cutPipelineJobId") REFERENCES "MediaArtifact"("id", "projectId", "lineageSourceId", "lineageSourceVersion", "pipelineJobId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceIntent" ADD CONSTRAINT "FrameEvidenceIntent_exact_profile" FOREIGN KEY ("creatorProfileRevisionId", "creatorProfileId", "creatorProfileRevisionNo") REFERENCES "CreatorProfileRevision"("id", "creatorProfileId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceIntent" ADD CONSTRAINT "FrameEvidenceIntent_exact_context" FOREIGN KEY ("sourceContextRevisionId", "sourceContextId", "sourceContextRevisionNo", "projectId", "sourceId", "sourceVersion", "creatorProfileId", "creatorProfileRevisionId", "creatorProfileRevisionNo") REFERENCES "SourceEditorialContextRevision"("id", "contextId", "revision", "projectId", "sourceId", "sourceVersion", "creatorProfileId", "creatorProfileRevisionId", "creatorProfileRevisionNo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceIntent" ADD CONSTRAINT "FrameEvidenceIntent_exact_prompt" FOREIGN KEY ("cutPromptRevisionId", "cutPromptId", "cutPromptRevisionNo", "projectId", "sourceId", "sourceVersion", "sourceContextId", "sourceContextRevisionId", "sourceContextRevisionNo") REFERENCES "CutEditorialPromptRevision"("id", "promptId", "revision", "projectId", "sourceId", "sourceVersion", "sourceContextId", "sourceContextRevisionId", "sourceContextRevisionNo") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceIntent" ADD CONSTRAINT "FrameEvidenceIntent_exact_prompt_cut" FOREIGN KEY ("cutPromptId", "cutPipelineJobId", "cutResultArtifactId", "projectId", "sourceId", "sourceVersion") REFERENCES "CutEditorialPrompt"("id", "cutPipelineJobId", "cutResultArtifactId", "projectId", "sourceId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameExtractionSlot" ADD CONSTRAINT "FrameExtractionSlot_resourceClass_fkey" FOREIGN KEY ("resourceClass") REFERENCES "FrameExtractionPool"("resourceClass") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameExtractionSlot" ADD CONSTRAINT "FrameExtractionSlot_attemptId_leaseToken_workDeadlineAt_fkey" FOREIGN KEY ("attemptId", "leaseToken", "workDeadlineAt") REFERENCES "FrameEvidenceAttempt"("id", "leaseToken", "workDeadlineAt") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceAttempt" ADD CONSTRAINT "FrameEvidenceAttempt_id_pipelineJobId_attemptNumber_leaseT_fkey" FOREIGN KEY ("id", "pipelineJobId", "attemptNumber", "leaseToken") REFERENCES "JobAttempt"("id", "jobId", "attemptNumber", "leaseToken") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceAttempt" ADD CONSTRAINT "FrameEvidenceAttempt_intentId_pipelineJobId_fkey" FOREIGN KEY ("intentId", "pipelineJobId") REFERENCES "FrameEvidenceIntent"("id", "pipelineJobId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceAttemptOutput" ADD CONSTRAINT "FrameEvidenceAttemptOutput_attemptId_intentId_attemptNumbe_fkey" FOREIGN KEY ("attemptId", "intentId", "attemptNumber") REFERENCES "FrameEvidenceAttempt"("id", "intentId", "attemptNumber") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceResult" ADD CONSTRAINT "FrameEvidenceResult_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "FrameEvidenceIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceResult" ADD CONSTRAINT "FrameEvidenceResult_attemptId_intentId_fkey" FOREIGN KEY ("attemptId", "intentId") REFERENCES "FrameEvidenceAttempt"("id", "intentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceFrame" ADD CONSTRAINT "FrameEvidenceFrame_resultId_intentId_attemptId_fkey" FOREIGN KEY ("resultId", "intentId", "attemptId") REFERENCES "FrameEvidenceResult"("id", "intentId", "attemptId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameEvidenceFrame" ADD CONSTRAINT "FrameEvidenceFrame_outputId_attemptId_intentId_ordinal_fkey" FOREIGN KEY ("outputId", "attemptId", "intentId", "ordinal") REFERENCES "FrameEvidenceAttemptOutput"("id", "attemptId", "intentId", "ordinal") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bound recipe inputs and durable admission reservations even for non-ORM writers.
ALTER TABLE "FrameEvidenceIntent" ADD CONSTRAINT "FrameEvidenceIntent_recipe_bounds" CHECK (
  "contractVersion" = 'editorial-sparse-frames-v1' AND "recipeVersion" = 'quartiles-jpeg-640-v1'
  AND "cutStartMs" >= 0 AND "cutEndMs" > "cutStartMs"
  AND "contractDurationMs" = "cutEndMs" - "cutStartMs"
  AND "contractDurationMs" BETWEEN 3 AND 600000
  AND "cutResultSizeBytes" BETWEEN 1 AND 536870912
  AND "cutResultSha256" ~ '^[0-9a-f]{64}$' AND "sourceSha256" ~ '^[0-9a-f]{64}$'
  AND "requestedPositionsMs" = jsonb_build_array(
    "contractDurationMs" / 4, "contractDurationMs" / 2, (3 * "contractDurationMs") / 4)
);
ALTER TABLE "FrameExtractionPool" ADD CONSTRAINT "FrameExtractionPool_capacity_bounds"
  CHECK ("resourceClass" = 'FRAME_EXTRACTION' AND "capacity" BETWEEN 1 AND 16);
ALTER TABLE "FrameExtractionSlot" ADD CONSTRAINT "FrameExtractionSlot_lease_identity"
  CHECK ("ordinal" BETWEEN 0 AND 15 AND
    (("attemptId" IS NULL AND "leaseToken" IS NULL AND "workDeadlineAt" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL)
     OR ("attemptId" IS NOT NULL AND "leaseToken" IS NOT NULL AND "workDeadlineAt" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "heartbeatAt" IS NOT NULL)));
ALTER TABLE "FrameEvidenceAttempt" ADD CONSTRAINT "FrameEvidenceAttempt_progress_bounds"
  CHECK ("attemptNumber" >= 1 AND "completedFrameCount" BETWEEN 0 AND 3 AND "progressBasisPoints" BETWEEN 0 AND 10000
    AND "progressPhase" IN ('READ_INPUT', 'EXTRACT', 'HASH', 'UPLOAD', 'FINALIZE')
    AND "scratchReservedBytes" > 12582912 AND "workDeadlineAt" > "createdAt"
    AND (("inputReadStartedAt" IS NULL AND "inputReadFingerprint" IS NULL) OR
      ("inputReadStartedAt" IS NOT NULL AND "inputReadFingerprint" IS NOT NULL)));
ALTER TABLE "FrameEvidenceAttemptOutput" ADD CONSTRAINT "FrameEvidenceAttemptOutput_state_bounds"
  CHECK ("ordinal" BETWEEN 0 AND 2 AND "state" IN ('PREPARED', 'UPLOADED', 'ACCEPTED', 'CLEANING', 'CLEANED')
    AND ("state" NOT IN ('UPLOADED', 'ACCEPTED') OR "measurement" IS NOT NULL)
    AND ("state" <> 'ACCEPTED' OR "cleanupStatus" = 'NOT_REQUIRED'));
ALTER TABLE "FrameEvidenceFrame" ADD CONSTRAINT "FrameEvidenceFrame_ordinal_bounds" CHECK ("ordinal" BETWEEN 0 AND 2);

ALTER TABLE "FrameEvidenceAttemptOutput" ADD CONSTRAINT "FrameEvidenceOutput_exact_key" CHECK ("objectKey" = 'ai-content/frame-evidence/' || "intentId"::text || '/attempts/' || "attemptNumber"::text || '/frames/' || "ordinal"::text);

-- Preserve legacy job-shape guards while admitting the owned frame variant.
ALTER TABLE "PipelineJob" DROP CONSTRAINT "PipelineJob_montage_type";
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_montage_type" CHECK (
  ("type"::text = 'MONTAGE_ASSET_PROBE' AND "montageAssetId" IS NOT NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'montage-asset-probe-v1')
  OR ("type"::text = 'ASSEMBLE_HORIZONTAL' AND "assemblyRenderIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'horizontal-render-v1')
  OR ("type"::text = 'EXPORT_EDITORIAL_PACKAGE' AND "editorialExportIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'editorial-export-zip-v1')
  OR ("type"::text IN ('SOURCE_PROBE','CUT_SEGMENT') AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL)
  OR ("type"::text = 'EXTRACT_EDITORIAL_FRAMES' AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'quartiles-jpeg-640-v1')
);
