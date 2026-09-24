-- Exact aggregate constraints prevent candidates and provenance from combining
-- identities captured by different image-suggestion intents.
ALTER TABLE "ImageSuggestionAttempt"
  ADD COLUMN "objectKey" TEXT,
  ADD COLUMN "cleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cleanupLastErrorCode" TEXT,
  ADD COLUMN "nextCleanupAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "cleanupCompletedAt" TIMESTAMP(3);

UPDATE "ImageSuggestionAttempt"
SET "objectKey" = 'ai-content/image-suggestions/' || "intentId"::text || '/attempts/' || "id"::text || '/candidate.png';

ALTER TABLE "ImageSuggestionAttempt"
  ALTER COLUMN "objectKey" SET NOT NULL,
  ADD CONSTRAINT "ImageSuggestionAttempt_objectKey_key" UNIQUE ("objectKey");

ALTER TABLE "ImageSuggestionAttempt"
  ADD CONSTRAINT "ImageSuggestionAttempt_id_intent_key" UNIQUE ("id", "intentId");

ALTER TABLE "ImageSuggestionCandidate"
  ADD CONSTRAINT "ImageSuggestionCandidate_id_intent_key" UNIQUE ("id", "intentId"),
  ADD CONSTRAINT "ImageSuggestionCandidate_exact_attempt_fkey"
    FOREIGN KEY ("attemptId", "intentId")
    REFERENCES "ImageSuggestionAttempt" ("id", "intentId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EditorialComponentProvenance"
  ADD CONSTRAINT "EditorialComponentProvenance_exact_image_candidate_fkey"
    FOREIGN KEY ("imageCandidateId", "imageIntentId")
    REFERENCES "ImageSuggestionCandidate" ("id", "intentId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EditorialComponentProvenance_image_contract_check"
    CHECK (
      (
        "component" = 'THUMBNAIL'
        AND (
          ("mode" = 'MANUAL' AND "imageIntentId" IS NULL AND "imageCandidateId" IS NULL)
          OR
          ("mode" IN ('AI_ASSISTED', 'MIXED') AND "imageIntentId" IS NOT NULL AND "imageCandidateId" IS NOT NULL)
        )
      )
      OR
      ("component" <> 'THUMBNAIL' AND "imageIntentId" IS NULL AND "imageCandidateId" IS NULL)
    );

CREATE INDEX "ImageSuggestionAttempt_cleanupStatus_nextCleanupAt_idx"
  ON "ImageSuggestionAttempt" ("cleanupStatus", "nextCleanupAt");
