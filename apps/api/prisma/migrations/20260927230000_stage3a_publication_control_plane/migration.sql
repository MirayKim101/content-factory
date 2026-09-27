-- ADR-010 Stage 3A: durable publication scheduling and local dry-run state.
-- This migration is additive. Rollback is admission-first: disable creation,
-- drain/reconcile claimed intents, and retain this publication history.
CREATE TYPE "PublicationPlatform" AS ENUM ('LOCAL_DRY_RUN', 'YOUTUBE', 'TIKTOK');
CREATE TYPE "PublicationChannelState" AS ENUM ('ENABLED', 'REVOKED');
CREATE TYPE "PublicationIntentState" AS ENUM (
  'SCHEDULED',
  'QUEUED',
  'PROCESSING',
  'UNKNOWN_REMOTE_STATE',
  'DRY_RUN_READY',
  'PUBLISHED',
  'FAILED_FINAL',
  'CANCELED'
);

CREATE TABLE "PublicationChannel" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL,
  "platform" "PublicationPlatform" NOT NULL,
  "displayName" TEXT NOT NULL,
  "externalChannelRef" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "state" "PublicationChannelState" NOT NULL DEFAULT 'ENABLED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublicationChannel_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationChannel_displayName_shape"
    CHECK (length(btrim("displayName")) BETWEEN 1 AND 120),
  CONSTRAINT "PublicationChannel_externalRef_shape"
    CHECK (length(btrim("externalChannelRef")) BETWEEN 1 AND 255),
  CONSTRAINT "PublicationChannel_timezone_shape"
    CHECK (length(btrim("timezone")) BETWEEN 1 AND 120),
  CONSTRAINT "PublicationChannel_project_platform_external_key"
    UNIQUE ("projectId", "platform", "externalChannelRef"),
  CONSTRAINT "PublicationChannel_id_projectId_key"
    UNIQUE ("id", "projectId"),
  CONSTRAINT "PublicationChannel_exact_target_key"
    UNIQUE ("id", "projectId", "platform")
);
CREATE INDEX "PublicationChannel_projectId_state_createdAt_id_idx"
  ON "PublicationChannel"("projectId", "state", "createdAt", "id");

-- The pair is needed by the exact export-result foreign key below. The older
-- three-column key also includes artifactId and cannot prove the pair alone.
ALTER TABLE "EditorialExportResult"
  ADD CONSTRAINT "EditorialExportResult_id_exportIntentId_key"
  UNIQUE ("id", "exportIntentId");

CREATE TABLE "PublicationIntent" (
  "id" UUID PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestFingerprint" TEXT NOT NULL,
  "projectId" UUID NOT NULL,
  "channelId" UUID NOT NULL,
  "approvalId" UUID NOT NULL,
  "exportIntentId" UUID NOT NULL,
  "exportResultId" UUID NOT NULL,
  "platform" "PublicationPlatform" NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL,
  "metadataSnapshot" JSONB NOT NULL,
  "state" "PublicationIntentState" NOT NULL DEFAULT 'SCHEDULED',
  "remotePublicationId" TEXT UNIQUE,
  "remoteStatus" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "retryBudget" INTEGER NOT NULL DEFAULT 3,
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "queuedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublicationIntent_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationIntent_exact_channel_target"
    FOREIGN KEY ("channelId", "projectId", "platform")
    REFERENCES "PublicationChannel"("id", "projectId", "platform") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationIntent_exact_approval_project"
    FOREIGN KEY ("approvalId", "projectId")
    REFERENCES "EditorialApproval"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationIntent_exact_export_result"
    FOREIGN KEY ("exportResultId", "exportIntentId")
    REFERENCES "EditorialExportResult"("id", "exportIntentId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationIntent_idempotencyKey_shape"
    CHECK (length(btrim("idempotencyKey")) BETWEEN 1 AND 200),
  CONSTRAINT "PublicationIntent_fingerprint_shape"
    CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "PublicationIntent_timezone_shape"
    CHECK (length(btrim("timezone")) BETWEEN 1 AND 120),
  CONSTRAINT "PublicationIntent_metadata_object"
    CHECK (jsonb_typeof("metadataSnapshot") = 'object'),
  CONSTRAINT "PublicationIntent_attempt_bounds"
    CHECK ("attemptCount" >= 0 AND "retryBudget" BETWEEN 0 AND 20 AND "attemptCount" <= "retryBudget" + 1),
  CONSTRAINT "PublicationIntent_failure_shape"
    CHECK (("failureCode" IS NULL) = ("failureMessage" IS NULL)),
  CONSTRAINT "PublicationIntent_terminal_timestamps"
    CHECK (
      ("state" = 'CANCELED' AND "canceledAt" IS NOT NULL AND "finishedAt" IS NOT NULL)
      OR ("state" IN ('DRY_RUN_READY', 'PUBLISHED', 'FAILED_FINAL') AND "finishedAt" IS NOT NULL AND "canceledAt" IS NULL)
      OR ("state" NOT IN ('CANCELED', 'DRY_RUN_READY', 'PUBLISHED', 'FAILED_FINAL') AND "finishedAt" IS NULL AND "canceledAt" IS NULL)
    ),
  CONSTRAINT "PublicationIntent_logical_target_key"
    UNIQUE ("channelId", "exportResultId", "platform")
);
CREATE INDEX "PublicationIntent_projectId_scheduledAt_id_idx"
  ON "PublicationIntent"("projectId", "scheduledAt", "id");
CREATE INDEX "PublicationIntent_state_scheduledAt_id_idx"
  ON "PublicationIntent"("state", "scheduledAt", "id");
CREATE INDEX "PublicationIntent_channelId_createdAt_id_idx"
  ON "PublicationIntent"("channelId", "createdAt", "id");

CREATE TABLE "PublicationResult" (
  "id" UUID PRIMARY KEY,
  "publicationIntentId" UUID NOT NULL UNIQUE,
  "resultContractVersion" TEXT NOT NULL DEFAULT 'publication-result-v1',
  "adapterVersion" TEXT NOT NULL,
  "providerReceipt" JSONB NOT NULL,
  "publicUrl" TEXT,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicationResult_publicationIntentId_fkey"
    FOREIGN KEY ("publicationIntentId") REFERENCES "PublicationIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PublicationResult_contract_version"
    CHECK ("resultContractVersion" = 'publication-result-v1'),
  CONSTRAINT "PublicationResult_adapterVersion_shape"
    CHECK (length(btrim("adapterVersion")) BETWEEN 1 AND 120),
  CONSTRAINT "PublicationResult_receipt_object"
    CHECK (jsonb_typeof("providerReceipt") = 'object'),
  CONSTRAINT "PublicationResult_publicUrl_shape"
    CHECK ("publicUrl" IS NULL OR length("publicUrl") BETWEEN 1 AND 2048)
);
