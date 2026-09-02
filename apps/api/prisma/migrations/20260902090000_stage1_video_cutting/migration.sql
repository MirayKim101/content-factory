-- Additive Stage 1 media cutting state. PostgreSQL remains authoritative;
-- queue records can be rebuilt from PipelineJob rows.
ALTER TYPE "MediaArtifactRole" ADD VALUE 'CUT_RESULT';

CREATE TYPE "PipelineJobType" AS ENUM ('SOURCE_PROBE', 'CUT_SEGMENT');
CREATE TYPE "PipelineJobState" AS ENUM ('QUEUED', 'PROCESSING', 'RETRY_WAIT', 'READY', 'FAILED_FINAL');
CREATE TYPE "JobAttemptState" AS ENUM ('QUEUED', 'PROCESSING', 'FAILED_RETRYABLE', 'READY', 'FAILED_FINAL');

ALTER TABLE "VideoSource"
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "probedAt" TIMESTAMP(3),
  ADD COLUMN "probeVersion" TEXT;

CREATE TABLE "CutRequest" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CutRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PipelineJob" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "cutRequestId" UUID,
  "type" "PipelineJobType" NOT NULL,
  "state" "PipelineJobState" NOT NULL DEFAULT 'QUEUED',
  "payloadVersion" INTEGER NOT NULL DEFAULT 1,
  "idempotencyKey" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "retryBudget" INTEGER NOT NULL DEFAULT 2,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "processedMs" INTEGER,
  "totalMs" INTEGER,
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "failureRetryable" BOOLEAN,
  "recipeVersion" TEXT NOT NULL,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PipelineJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CutSegment" (
  "id" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "clientSegmentId" TEXT NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CutSegment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CutSegment_valid_bounds" CHECK ("startMs" >= 0 AND "endMs" > "startMs")
);

CREATE TABLE "JobAttempt" (
  "id" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "state" "JobAttemptState" NOT NULL DEFAULT 'QUEUED',
  "workerId" TEXT,
  "leaseToken" TEXT,
  "startedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobAttempt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MediaArtifact"
  ADD COLUMN "pipelineJobId" UUID,
  ADD COLUMN "ffmpegVersion" TEXT,
  ADD COLUMN "outputFilename" TEXT;

CREATE UNIQUE INDEX "CutRequest_idempotencyKey_key" ON "CutRequest"("idempotencyKey");
CREATE INDEX "CutRequest_projectId_createdAt_idx" ON "CutRequest"("projectId", "createdAt");
CREATE UNIQUE INDEX "PipelineJob_idempotencyKey_key" ON "PipelineJob"("idempotencyKey");
CREATE UNIQUE INDEX "PipelineJob_leaseToken_key" ON "PipelineJob"("leaseToken");
CREATE INDEX "PipelineJob_state_type_priority_queuedAt_idx" ON "PipelineJob"("state", "type", "priority", "queuedAt");
CREATE INDEX "PipelineJob_leaseExpiresAt_idx" ON "PipelineJob"("leaseExpiresAt");
CREATE INDEX "PipelineJob_projectId_createdAt_idx" ON "PipelineJob"("projectId", "createdAt");
CREATE UNIQUE INDEX "CutSegment_jobId_key" ON "CutSegment"("jobId");
CREATE UNIQUE INDEX "CutSegment_jobId_clientSegmentId_key" ON "CutSegment"("jobId", "clientSegmentId");
CREATE UNIQUE INDEX "JobAttempt_jobId_attemptNumber_key" ON "JobAttempt"("jobId", "attemptNumber");
CREATE INDEX "JobAttempt_state_updatedAt_idx" ON "JobAttempt"("state", "updatedAt");
CREATE UNIQUE INDEX "MediaArtifact_pipelineJobId_key" ON "MediaArtifact"("pipelineJobId");

ALTER TABLE "CutRequest" ADD CONSTRAINT "CutRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "VideoSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_cutRequestId_fkey" FOREIGN KEY ("cutRequestId") REFERENCES "CutRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CutSegment" ADD CONSTRAINT "CutSegment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PipelineJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PipelineJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaArtifact" ADD CONSTRAINT "MediaArtifact_pipelineJobId_fkey" FOREIGN KEY ("pipelineJobId") REFERENCES "PipelineJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
