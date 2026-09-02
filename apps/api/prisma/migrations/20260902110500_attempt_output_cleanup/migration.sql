ALTER TABLE "JobAttempt"
  ADD COLUMN "outputObjectKey" TEXT,
  ADD COLUMN "cleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cleanupLastErrorCode" TEXT,
  ADD COLUMN "cleanupRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cleanupCompletedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "JobAttempt_outputObjectKey_key"
  ON "JobAttempt"("outputObjectKey");

CREATE INDEX "JobAttempt_cleanupStatus_updatedAt_idx"
  ON "JobAttempt"("cleanupStatus", "updatedAt");
