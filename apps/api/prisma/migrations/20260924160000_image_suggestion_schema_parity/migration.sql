-- Remove redundant single-column relations now represented by exact composite
-- aggregate relations in the Prisma schema.
ALTER TABLE "ImageSuggestionCandidate"
  DROP CONSTRAINT "ImageSuggestionCandidate_attemptId_fkey",
  ADD CONSTRAINT "ImageSuggestionCandidate_attempt_intent_key" UNIQUE ("attemptId", "intentId");

ALTER TABLE "EditorialComponentProvenance"
  DROP CONSTRAINT "EditorialComponentProvenance_imageCandidateId_fkey";

-- Accepted attempt objects are authoritative candidate bytes, not cleanup work.
UPDATE "ImageSuggestionAttempt" a
SET "cleanupStatus" = 'NOT_REQUIRED',
    "cleanupLastErrorCode" = NULL,
    "cleanupCompletedAt" = NULL
WHERE EXISTS (
  SELECT 1 FROM "ImageSuggestionCandidate" c WHERE c."attemptId" = a."id" AND c."intentId" = a."intentId"
);
