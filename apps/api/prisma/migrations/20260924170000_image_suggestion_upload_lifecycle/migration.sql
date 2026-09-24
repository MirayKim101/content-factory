ALTER TABLE "ImageSuggestionAttempt"
  ADD COLUMN "uploadStartedAt" TIMESTAMP(3),
  ADD COLUMN "uploadSettledAt" TIMESTAMP(3);

-- Existing accepted candidates prove their upload settled successfully.
UPDATE "ImageSuggestionAttempt" a
SET "uploadStartedAt" = coalesce("uploadStartedAt", a."createdAt"),
    "uploadSettledAt" = coalesce("uploadSettledAt", a."updatedAt")
WHERE EXISTS (
  SELECT 1 FROM "ImageSuggestionCandidate" c WHERE c."attemptId" = a."id" AND c."intentId" = a."intentId"
);
