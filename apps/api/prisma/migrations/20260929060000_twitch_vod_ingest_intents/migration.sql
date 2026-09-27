CREATE TYPE "TwitchVodIngestState" AS ENUM (
  'QUEUED', 'DOWNLOADING', 'UPLOADING', 'RETRY_WAIT', 'READY', 'FAILED_FINAL', 'CANCELED'
);

CREATE TABLE "TwitchVodIngestIntent" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "candidateId" UUID NOT NULL,
  "state" "TwitchVodIngestState" NOT NULL DEFAULT 'QUEUED',
  "projectName" TEXT NOT NULL,
  "projectId" UUID,
  "downloadedBytes" BIGINT NOT NULL DEFAULT 0,
  "totalBytes" BIGINT,
  "objectKey" TEXT,
  "sha256" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TwitchVodIngestIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TwitchVodIngestIntent_progress_check" CHECK ("downloadedBytes" >= 0 AND ("totalBytes" IS NULL OR "totalBytes" > 0) AND ("totalBytes" IS NULL OR "downloadedBytes" <= "totalBytes")),
  CONSTRAINT "TwitchVodIngestIntent_ready_check" CHECK (("state" = 'READY') = ("projectId" IS NOT NULL)),
  CONSTRAINT "TwitchVodIngestIntent_lease_check" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL))
);

CREATE UNIQUE INDEX "TwitchVodIngestIntent_idempotencyKey_key" ON "TwitchVodIngestIntent"("idempotencyKey");
CREATE UNIQUE INDEX "TwitchVodIngestIntent_candidateId_key" ON "TwitchVodIngestIntent"("candidateId");
CREATE UNIQUE INDEX "TwitchVodIngestIntent_projectId_key" ON "TwitchVodIngestIntent"("projectId");
CREATE INDEX "TwitchVodIngestIntent_state_nextAttemptAt_createdAt_id_idx" ON "TwitchVodIngestIntent"("state", "nextAttemptAt", "createdAt", "id");
CREATE INDEX "TwitchVodIngestIntent_leaseExpiresAt_idx" ON "TwitchVodIngestIntent"("leaseExpiresAt");

ALTER TABLE "TwitchVodIngestIntent" ADD CONSTRAINT "TwitchVodIngestIntent_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "TwitchVodCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TwitchVodIngestIntent" ADD CONSTRAINT "TwitchVodIngestIntent_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
