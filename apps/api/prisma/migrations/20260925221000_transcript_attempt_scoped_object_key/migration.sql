-- A transcript attempt must own a distinct private object. This prevents a
-- late worker from overwriting or deleting the artifact accepted from a newer
-- attempt. Existing canonical keys remain valid for backward compatibility.
ALTER TABLE "TranscriptEvidenceArtifact"
  DROP CONSTRAINT "TranscriptEvidenceArtifact_private_key_check";

ALTER TABLE "TranscriptEvidenceArtifact"
  ADD CONSTRAINT "TranscriptEvidenceArtifact_private_key_check"
  CHECK (
    "objectKey" ~ '^ai-content/transcripts/[0-9a-f-]{36}/transcript[.]json$'
    OR "objectKey" ~ '^ai-content/transcripts/[0-9a-f-]{36}/attempts/[0-9a-f-]{36}/transcript[.]json$'
  );

ALTER TABLE "TranscriptEvidenceAttempt"
  ADD COLUMN "objectKey" TEXT,
  ADD COLUMN "uploadStartedAt" TIMESTAMP(3),
  ADD COLUMN "uploadSettledAt" TIMESTAMP(3),
  ADD COLUMN "cleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cleanupLastErrorCode" TEXT,
  ADD COLUMN "cleanupLeaseToken" TEXT,
  ADD COLUMN "cleanupLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "nextCleanupAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "cleanupCompletedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "TranscriptEvidenceAttempt_object_key_check" CHECK (
    "objectKey" IS NULL
    OR "objectKey" ~ '^ai-content/transcripts/[0-9a-f-]{36}/attempts/[0-9a-f-]{36}/transcript[.]json$'
  );

CREATE UNIQUE INDEX "TranscriptEvidenceAttempt_objectKey_key"
  ON "TranscriptEvidenceAttempt"("objectKey");

CREATE UNIQUE INDEX "TranscriptEvidenceAttempt_cleanupLeaseToken_key"
  ON "TranscriptEvidenceAttempt"("cleanupLeaseToken");

CREATE INDEX "TranscriptEvidenceAttempt_cleanupStatus_nextCleanupAt_idx"
  ON "TranscriptEvidenceAttempt"("cleanupStatus", "nextCleanupAt");
