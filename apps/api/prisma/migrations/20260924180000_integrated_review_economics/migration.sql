-- Stage 2B-6 is additive. New v2 admission remains disabled by default.
ALTER TABLE "EditorialApproval" DROP CONSTRAINT "EditorialApproval_approvalContractVersion_check";
ALTER TABLE "EditorialApproval" ADD CONSTRAINT "EditorialApproval_approvalContractVersion_check"
  CHECK ("approvalContractVersion" IN ('manual-horizontal-approval-v1', 'human-horizontal-approval-v2'));

ALTER TABLE "EditorialExportIntent" DROP CONSTRAINT "EditorialExportIntent_exportContractVersion_check";
ALTER TABLE "EditorialExportIntent" ADD CONSTRAINT "EditorialExportIntent_exportContractVersion_check"
  CHECK ("exportContractVersion" IN ('editorial-export-zip-v1', 'editorial-export-zip-v2'));

ALTER TABLE "EditorialExportResult" DROP CONSTRAINT "EditorialExportResult_exportContractVersion_check";
ALTER TABLE "EditorialExportResult" ADD CONSTRAINT "EditorialExportResult_exportContractVersion_check"
  CHECK ("exportContractVersion" IN ('editorial-export-zip-v1', 'editorial-export-zip-v2'));

ALTER TABLE "PipelineJob" DROP CONSTRAINT "PipelineJob_montage_type";
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_montage_type" CHECK (
  ("type"::text = 'MONTAGE_ASSET_PROBE' AND "montageAssetId" IS NOT NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'montage-asset-probe-v1')
  OR ("type"::text = 'ASSEMBLE_HORIZONTAL' AND "assemblyRenderIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'horizontal-render-v1')
  OR ("type"::text = 'EXPORT_EDITORIAL_PACKAGE' AND "editorialExportIntentId" IS NOT NULL AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "cutRequestId" IS NULL AND (("payloadVersion" = 1 AND "recipeVersion" = 'editorial-export-zip-v1') OR ("payloadVersion" = 2 AND "recipeVersion" = 'editorial-export-zip-v2')))
  OR ("type"::text IN ('SOURCE_PROBE','CUT_SEGMENT') AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL)
  OR ("type"::text = 'EXTRACT_EDITORIAL_FRAMES' AND "montageAssetId" IS NULL AND "assemblyRenderIntentId" IS NULL AND "editorialExportIntentId" IS NULL AND "cutRequestId" IS NULL AND "payloadVersion" = 1 AND "recipeVersion" = 'quartiles-jpeg-640-v1')
);

CREATE TABLE "EditorialApprovalComponentSnapshot" (
    "id" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "editorialPackageRevisionId" UUID NOT NULL,
    "component" "EditorialComponentType" NOT NULL,
    "provenanceId" UUID NOT NULL,
    "mode" "EditorialProvenanceMode" NOT NULL,
    "basisVersion" TEXT NOT NULL,
    "researchIntentId" UUID,
    "suggestionSetId" UUID,
    "imageIntentId" UUID,
    "imageCandidateId" UUID,
    "transcriptArtifactId" UUID,
    "transcriptSha256" TEXT,
    "citations" JSONB NOT NULL,
    "freshness" JSONB,
    "imageSafetyDecision" JSONB,
    "likeness" TEXT,
    "directCostMicrousd" BIGINT NOT NULL,
    "costBasisVersion" TEXT NOT NULL,
    "incompleteReasons" JSONB NOT NULL,
    "snapshotFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialApprovalComponentSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EditorialApprovalComponentSnapshot_cost_nonnegative" CHECK ("directCostMicrousd" >= 0),
    CONSTRAINT "EditorialApprovalComponentSnapshot_fingerprint" CHECK ("snapshotFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "EditorialApprovalComponentSnapshot_transcript_checksum" CHECK ("transcriptSha256" IS NULL OR "transcriptSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "EditorialApprovalComponentSnapshot_component_contract" CHECK (
      ("component" = 'METADATA' AND "imageIntentId" IS NULL AND "imageCandidateId" IS NULL AND "imageSafetyDecision" IS NULL AND "likeness" IS NULL)
      OR
      ("component" = 'THUMBNAIL' AND "researchIntentId" IS NULL AND "suggestionSetId" IS NULL AND "transcriptArtifactId" IS NULL AND "transcriptSha256" IS NULL AND "freshness" IS NULL)
    ),
    CONSTRAINT "EditorialApprovalComponentSnapshot_mode_contract" CHECK (
      ("mode" = 'MANUAL' AND "researchIntentId" IS NULL AND "suggestionSetId" IS NULL AND "imageIntentId" IS NULL AND "imageCandidateId" IS NULL AND "directCostMicrousd" = 0 AND "costBasisVersion" = "basisVersion")
      OR
      ("component" = 'METADATA' AND "mode" IN ('AI_ASSISTED', 'MIXED') AND "researchIntentId" IS NOT NULL AND "suggestionSetId" IS NOT NULL AND "imageIntentId" IS NULL AND "imageCandidateId" IS NULL)
      OR
      ("component" = 'THUMBNAIL' AND "mode" = 'AI_ASSISTED' AND "imageIntentId" IS NOT NULL AND "imageCandidateId" IS NOT NULL AND "researchIntentId" IS NULL AND "suggestionSetId" IS NULL)
    )
);

CREATE TABLE "EditorialApprovalEconomicsV2" (
    "approvalId" UUID NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "workflowMode" "EditorialProvenanceMode" NOT NULL,
    "attentionSchemaVersion" TEXT NOT NULL,
    "preparationForegroundMs" INTEGER NOT NULL,
    "finalReviewForegroundMs" INTEGER NOT NULL,
    "totalOperatorAttentionMs" INTEGER NOT NULL,
    "metadataDirectCostMicrousd" BIGINT NOT NULL,
    "evidenceDirectCostMicrousd" BIGINT NOT NULL,
    "thumbnailDirectCostMicrousd" BIGINT NOT NULL,
    "combinedDirectCostMicrousd" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "metadataCostBasisVersion" TEXT NOT NULL,
    "evidenceCostBasisVersion" TEXT NOT NULL,
    "thumbnailCostBasisVersion" TEXT NOT NULL,
    "assistanceTiming" JSONB,
    "incompleteReasons" JSONB NOT NULL,
    "snapshotFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialApprovalEconomicsV2_pkey" PRIMARY KEY ("approvalId"),
    CONSTRAINT "EditorialApprovalEconomicsV2_versions" CHECK ("schemaVersion" = 'approval-economics-v2' AND "attentionSchemaVersion" = 'operator-attention-v2'),
    CONSTRAINT "EditorialApprovalEconomicsV2_units" CHECK ("currency" = 'USD' AND "unit" = 'MICRO'),
    CONSTRAINT "EditorialApprovalEconomicsV2_attention" CHECK (
      "preparationForegroundMs" >= 0 AND "finalReviewForegroundMs" >= 0
      AND "preparationForegroundMs" <= 28800000 AND "finalReviewForegroundMs" <= 28800000
      AND "totalOperatorAttentionMs" = "preparationForegroundMs" + "finalReviewForegroundMs"
      AND "totalOperatorAttentionMs" <= 28800000
    ),
    CONSTRAINT "EditorialApprovalEconomicsV2_cost" CHECK (
      "metadataDirectCostMicrousd" >= 0 AND "evidenceDirectCostMicrousd" >= 0
      AND "thumbnailDirectCostMicrousd" >= 0
      AND "combinedDirectCostMicrousd" = "metadataDirectCostMicrousd" + "evidenceDirectCostMicrousd" + "thumbnailDirectCostMicrousd"
    ),
    CONSTRAINT "EditorialApprovalEconomicsV2_fingerprint" CHECK ("snapshotFingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "EditorialApprovalComponentSnapshot_approval_component_key"
  ON "EditorialApprovalComponentSnapshot"("approvalId", "component");
CREATE UNIQUE INDEX "EditorialApproval_id_revision_key"
  ON "EditorialApproval"("id", "editorialPackageRevisionId");
CREATE UNIQUE INDEX "EditorialComponentProvenance_exact_snapshot_key"
  ON "EditorialComponentProvenance"("id", "packageRevisionId", "component");
CREATE UNIQUE INDEX "ResearchSuggestionSet_id_intent_key" ON "ResearchSuggestionSet"("id", "intentId");
CREATE INDEX "EditorialApprovalComponentSnapshot_provenanceId_idx" ON "EditorialApprovalComponentSnapshot"("provenanceId");
CREATE INDEX "EditorialApprovalComponentSnapshot_researchIntentId_idx" ON "EditorialApprovalComponentSnapshot"("researchIntentId");
CREATE INDEX "EditorialApprovalComponentSnapshot_suggestionSetId_idx" ON "EditorialApprovalComponentSnapshot"("suggestionSetId");
CREATE INDEX "EditorialApprovalComponentSnapshot_imageIntentId_idx" ON "EditorialApprovalComponentSnapshot"("imageIntentId");
CREATE INDEX "EditorialApprovalComponentSnapshot_imageCandidateId_idx" ON "EditorialApprovalComponentSnapshot"("imageCandidateId");

ALTER TABLE "EditorialApprovalComponentSnapshot" ADD CONSTRAINT "EditorialApprovalComponentSnapshot_exact_approval_revision_fkey"
  FOREIGN KEY ("approvalId", "editorialPackageRevisionId") REFERENCES "EditorialApproval"("id", "editorialPackageRevisionId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialApprovalComponentSnapshot" ADD CONSTRAINT "EditorialApprovalComponentSnapshot_exact_provenance_fkey"
  FOREIGN KEY ("provenanceId", "editorialPackageRevisionId", "component") REFERENCES "EditorialComponentProvenance"("id", "packageRevisionId", "component") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialApprovalComponentSnapshot" ADD CONSTRAINT "EditorialApprovalComponentSnapshot_researchIntentId_fkey"
  FOREIGN KEY ("researchIntentId") REFERENCES "ResearchSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialApprovalComponentSnapshot" ADD CONSTRAINT "EditorialApprovalComponentSnapshot_exact_suggestion_fkey"
  FOREIGN KEY ("suggestionSetId", "researchIntentId") REFERENCES "ResearchSuggestionSet"("id", "intentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialApprovalComponentSnapshot" ADD CONSTRAINT "EditorialApprovalComponentSnapshot_imageIntentId_fkey"
  FOREIGN KEY ("imageIntentId") REFERENCES "ImageSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialApprovalComponentSnapshot" ADD CONSTRAINT "EditorialApprovalComponentSnapshot_exact_image_fkey"
  FOREIGN KEY ("imageCandidateId", "imageIntentId") REFERENCES "ImageSuggestionCandidate"("id", "intentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialApprovalComponentSnapshot" ADD CONSTRAINT "EditorialApprovalComponentSnapshot_transcriptArtifactId_fkey"
  FOREIGN KEY ("transcriptArtifactId") REFERENCES "TranscriptEvidenceArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialApprovalEconomicsV2" ADD CONSTRAINT "EditorialApprovalEconomicsV2_approvalId_fkey"
  FOREIGN KEY ("approvalId") REFERENCES "EditorialApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
