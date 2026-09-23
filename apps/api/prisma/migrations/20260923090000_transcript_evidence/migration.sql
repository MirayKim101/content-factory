-- Add deterministic transcript evidence to the owned AI Content module.
ALTER TYPE "AiContentOperationType" ADD VALUE 'CREATE_TRANSCRIPT_EVIDENCE';

CREATE TYPE "TranscriptIntentState" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED_FINAL');
CREATE TYPE "TranscriptAttemptState" AS ENUM ('PROCESSING', 'READY', 'FAILED_FINAL');

CREATE TABLE "TranscriptEvidenceIntent" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "sourceAuthorizationRevision" INTEGER NOT NULL,
    "cutPipelineJobId" UUID NOT NULL,
    "cutResultArtifactId" UUID NOT NULL,
    "cutResultSha256" TEXT NOT NULL,
    "cutResultSizeBytes" BIGINT NOT NULL,
    "cutStartMs" INTEGER NOT NULL,
    "cutEndMs" INTEGER NOT NULL,
    "creatorProfileRevisionId" UUID NOT NULL,
    "creatorProfileRevisionNo" INTEGER NOT NULL,
    "sourceContextRevisionId" UUID NOT NULL,
    "sourceContextRevisionNo" INTEGER NOT NULL,
    "cutPromptRevisionId" UUID NOT NULL,
    "cutPromptRevisionNo" INTEGER NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "fixture" JSONB NOT NULL,
    "state" "TranscriptIntentState" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "retryBudget" INTEGER NOT NULL DEFAULT 1,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptEvidenceIntent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TranscriptEvidenceIntent_cut_bounds_check" CHECK ("cutStartMs" >= 0 AND "cutEndMs" > "cutStartMs"),
    CONSTRAINT "TranscriptEvidenceIntent_sha_check" CHECK ("sourceSha256" ~ '^[0-9a-f]{64}$' AND "cutResultSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "TranscriptEvidenceIntent_size_check" CHECK ("cutResultSizeBytes" > 0),
    CONSTRAINT "TranscriptEvidenceIntent_attempt_check" CHECK ("attemptCount" >= 0 AND "retryBudget" >= 0)
);

CREATE TABLE "TranscriptEvidenceAttempt" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "state" "TranscriptAttemptState" NOT NULL DEFAULT 'PROCESSING',
    "workerId" TEXT NOT NULL,
    "leaseToken" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "workDeadlineAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,

    CONSTRAINT "TranscriptEvidenceAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TranscriptEvidenceAttempt_number_check" CHECK ("attemptNumber" > 0),
    CONSTRAINT "TranscriptEvidenceAttempt_deadline_check" CHECK ("workDeadlineAt" >= "leaseExpiresAt")
);

CREATE TABLE "TranscriptEvidenceArtifact" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "segments" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptEvidenceArtifact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TranscriptEvidenceArtifact_private_key_check" CHECK ("objectKey" ~ '^ai-content/transcripts/[0-9a-f-]{36}/transcript\\.json$'),
    CONSTRAINT "TranscriptEvidenceArtifact_content_check" CHECK ("contentType" = 'application/json' AND "sizeBytes" > 0 AND "sha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "TranscriptEvidenceIntent_idempotencyKey_key" ON "TranscriptEvidenceIntent"("idempotencyKey");
CREATE INDEX "TranscriptEvidenceIntent_cutPipelineJobId_createdAt_id_idx" ON "TranscriptEvidenceIntent"("cutPipelineJobId", "createdAt", "id");
CREATE INDEX "TranscriptEvidenceIntent_state_queuedAt_idx" ON "TranscriptEvidenceIntent"("state", "queuedAt");
CREATE UNIQUE INDEX "TranscriptEvidenceAttempt_leaseToken_key" ON "TranscriptEvidenceAttempt"("leaseToken");
CREATE UNIQUE INDEX "TranscriptEvidenceAttempt_intentId_attemptNumber_key" ON "TranscriptEvidenceAttempt"("intentId", "attemptNumber");
CREATE INDEX "TranscriptEvidenceAttempt_state_leaseExpiresAt_idx" ON "TranscriptEvidenceAttempt"("state", "leaseExpiresAt");
CREATE UNIQUE INDEX "TranscriptEvidenceArtifact_intentId_key" ON "TranscriptEvidenceArtifact"("intentId");
CREATE UNIQUE INDEX "TranscriptEvidenceArtifact_objectKey_key" ON "TranscriptEvidenceArtifact"("objectKey");

ALTER TABLE "TranscriptEvidenceIntent" ADD CONSTRAINT "TranscriptEvidenceIntent_cutPipelineJobId_fkey" FOREIGN KEY ("cutPipelineJobId") REFERENCES "PipelineJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptEvidenceIntent" ADD CONSTRAINT "TranscriptEvidenceIntent_cutResultArtifactId_fkey" FOREIGN KEY ("cutResultArtifactId") REFERENCES "MediaArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptEvidenceIntent" ADD CONSTRAINT "TranscriptEvidenceIntent_creatorProfileRevisionId_fkey" FOREIGN KEY ("creatorProfileRevisionId") REFERENCES "CreatorProfileRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptEvidenceIntent" ADD CONSTRAINT "TranscriptEvidenceIntent_sourceContextRevisionId_fkey" FOREIGN KEY ("sourceContextRevisionId") REFERENCES "SourceEditorialContextRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptEvidenceIntent" ADD CONSTRAINT "TranscriptEvidenceIntent_cutPromptRevisionId_fkey" FOREIGN KEY ("cutPromptRevisionId") REFERENCES "CutEditorialPromptRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptEvidenceAttempt" ADD CONSTRAINT "TranscriptEvidenceAttempt_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "TranscriptEvidenceIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TranscriptEvidenceArtifact" ADD CONSTRAINT "TranscriptEvidenceArtifact_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "TranscriptEvidenceIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
