-- Stage 1 manual horizontal cut is additive. PostgreSQL remains authoritative;
-- Redis only carries recoverable job references.
BEGIN;

ALTER TYPE "MediaArtifactRole" ADD VALUE 'HORIZONTAL_CUT';

CREATE TYPE "PipelineJobType" AS ENUM ('HORIZONTAL_CUT');
CREATE TYPE "PipelineJobState" AS ENUM (
  'QUEUED',
  'RUNNING',
  'FAILED_RETRYABLE',
  'SUCCEEDED',
  'FAILED_FINAL'
);
CREATE TYPE "JobAttemptState" AS ENUM (
  'RUNNING',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'SUCCEEDED',
  'ABANDONED'
);

CREATE TABLE "PipelineJob" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "type" "PipelineJobType" NOT NULL,
  "state" "PipelineJobState" NOT NULL DEFAULT 'QUEUED',
  "sourceVersion" INTEGER NOT NULL,
  "sourceSha256" CHAR(64) NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "recipeVersion" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "currentAttemptId" UUID,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "admissionDeadlineAt" TIMESTAMP(3) NOT NULL,
  "stage" TEXT NOT NULL DEFAULT 'QUEUED',
  "progressCurrent" BIGINT,
  "progressTotal" BIGINT,
  "progressUnit" TEXT,
  "queueReason" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "winningArtifactId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PipelineJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PipelineJob_range_check" CHECK (
    "startMs" >= 0 AND "startMs" < "endMs" AND "endMs" <= 2147483647
  ),
  CONSTRAINT "PipelineJob_attempt_budget_check" CHECK (
    "maxAttempts" > 0 AND "attemptCount" >= 0 AND "attemptCount" <= "maxAttempts"
  ),
  CONSTRAINT "PipelineJob_progress_check" CHECK (
    ("progressCurrent" IS NULL AND "progressTotal" IS NULL AND "progressUnit" IS NULL)
    OR
    ("progressCurrent" >= 0 AND "progressTotal" > 0 AND "progressCurrent" <= "progressTotal" AND "progressUnit" IS NOT NULL)
  )
);

CREATE TABLE "JobAttempt" (
  "id" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "state" "JobAttemptState" NOT NULL DEFAULT 'RUNNING',
  "claimRevision" INTEGER NOT NULL,
  "leaseToken" UUID NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  "reservedScratchBytes" BIGINT NOT NULL,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "outputObjectKey" TEXT,
  "outputCleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  "outputCleanupAttempts" INTEGER NOT NULL DEFAULT 0,
  "outputCleanupLastError" TEXT,
  "outputCleanupRequestedAt" TIMESTAMP(3),
  "outputCleanupCompletedAt" TIMESTAMP(3),
  CONSTRAINT "JobAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JobAttempt_number_check" CHECK ("attemptNumber" > 0),
  CONSTRAINT "JobAttempt_scratch_check" CHECK ("reservedScratchBytes" >= 0)
);

CREATE UNIQUE INDEX "PipelineJob_winningArtifactId_key" ON "PipelineJob"("winningArtifactId");
CREATE UNIQUE INDEX "PipelineJob_projectId_idempotencyKey_key" ON "PipelineJob"("projectId", "idempotencyKey");
CREATE INDEX "PipelineJob_projectId_createdAt_id_idx" ON "PipelineJob"("projectId", "createdAt", "id");
CREATE INDEX "PipelineJob_state_nextAttemptAt_idx" ON "PipelineJob"("state", "nextAttemptAt");
CREATE UNIQUE INDEX "JobAttempt_leaseToken_key" ON "JobAttempt"("leaseToken");
CREATE UNIQUE INDEX "JobAttempt_outputObjectKey_key" ON "JobAttempt"("outputObjectKey");
CREATE UNIQUE INDEX "JobAttempt_jobId_attemptNumber_key" ON "JobAttempt"("jobId", "attemptNumber");
CREATE INDEX "JobAttempt_state_leaseExpiresAt_idx" ON "JobAttempt"("state", "leaseExpiresAt");
CREATE INDEX "JobAttempt_outputCleanupStatus_outputCleanupRequestedAt_idx" ON "JobAttempt"("outputCleanupStatus", "outputCleanupRequestedAt");

ALTER TABLE "PipelineJob"
  ADD CONSTRAINT "PipelineJob_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineJob"
  ADD CONSTRAINT "PipelineJob_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "VideoSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineJob"
  ADD CONSTRAINT "PipelineJob_winningArtifactId_fkey"
  FOREIGN KEY ("winningArtifactId") REFERENCES "MediaArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobAttempt"
  ADD CONSTRAINT "JobAttempt_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "PipelineJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
