-- Prisma owns TranscriptEvidenceAttempt.updatedAt through @updatedAt. The
-- preceding deployed migration used a database default while adding the
-- required column. Preserve every existing row, then remove that default so
-- a fresh migration replay and the Prisma schema describe the same contract.
UPDATE "TranscriptEvidenceAttempt"
SET "updatedAt" = COALESCE("updatedAt", "startedAt", CURRENT_TIMESTAMP);

ALTER TABLE "TranscriptEvidenceAttempt"
  ALTER COLUMN "updatedAt" DROP DEFAULT;
