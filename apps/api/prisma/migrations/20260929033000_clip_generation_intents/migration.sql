CREATE TYPE "ClipGenerationIntentState" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED_FINAL');

CREATE TABLE "ClipGenerationIntent" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "sourceTitle" TEXT NOT NULL,
  "sourceDurationMs" INTEGER NOT NULL,
  "transcript" JSONB NOT NULL,
  "transcriptSha256" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "maximumSuggestions" INTEGER NOT NULL,
  "minimumClipDurationMs" INTEGER NOT NULL,
  "maximumClipDurationMs" INTEGER NOT NULL,
  "externalTransferAllowed" BOOLEAN NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "contractVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "state" "ClipGenerationIntentState" NOT NULL DEFAULT 'QUEUED',
  "providerRequestId" TEXT,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClipGenerationIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClipGenerationIntent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ClipGenerationIntent_exact_source" FOREIGN KEY ("sourceId", "projectId", "sourceVersion") REFERENCES "VideoSource"("id", "projectId", "sourceVersion") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ClipGenerationIntent_transfer_check" CHECK ("externalTransferAllowed" = TRUE),
  CONSTRAINT "ClipGenerationIntent_duration_check" CHECK ("sourceDurationMs" > 0 AND "minimumClipDurationMs" >= 5000 AND "maximumClipDurationMs" >= "minimumClipDurationMs" AND "maximumClipDurationMs" <= 600000),
  CONSTRAINT "ClipGenerationIntent_count_check" CHECK ("maximumSuggestions" BETWEEN 1 AND 20),
  CONSTRAINT "ClipGenerationIntent_attempt_check" CHECK ("attemptCount" BETWEEN 0 AND 2)
);

CREATE UNIQUE INDEX "ClipGenerationIntent_idempotencyKey_key" ON "ClipGenerationIntent"("idempotencyKey");
CREATE UNIQUE INDEX "ClipGenerationIntent_leaseToken_key" ON "ClipGenerationIntent"("leaseToken");
CREATE UNIQUE INDEX "ClipGenerationIntent_id_projectId_sourceId_sourceVersion_key" ON "ClipGenerationIntent"("id", "projectId", "sourceId", "sourceVersion");
CREATE INDEX "ClipGenerationIntent_state_leaseExpiresAt_createdAt_id_idx" ON "ClipGenerationIntent"("state", "leaseExpiresAt", "createdAt", "id");
CREATE INDEX "ClipGenerationIntent_projectId_createdAt_id_idx" ON "ClipGenerationIntent"("projectId", "createdAt", "id");

CREATE TABLE "ClipGenerationSuggestion" (
  "id" UUID NOT NULL,
  "intentId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "confidenceBasisPoints" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClipGenerationSuggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClipGenerationSuggestion_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ClipGenerationIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ClipGenerationSuggestion_interval_check" CHECK ("startMs" >= 0 AND "endMs" > "startMs"),
  CONSTRAINT "ClipGenerationSuggestion_confidence_check" CHECK ("confidenceBasisPoints" BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX "ClipGenerationSuggestion_intentId_ordinal_key" ON "ClipGenerationSuggestion"("intentId", "ordinal");
CREATE INDEX "ClipGenerationSuggestion_intentId_startMs_endMs_idx" ON "ClipGenerationSuggestion"("intentId", "startMs", "endMs");
