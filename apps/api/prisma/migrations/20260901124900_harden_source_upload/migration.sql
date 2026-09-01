-- CreateEnum
CREATE TYPE "ArtifactCleanupStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'COMPLETED');

-- AlterTable
ALTER TABLE "MediaArtifact" ADD COLUMN "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cleanupCompletedAt" TIMESTAMP(3),
ADD COLUMN "cleanupLastErrorCode" TEXT,
ADD COLUMN "cleanupRequestedAt" TIMESTAMP(3),
ADD COLUMN "cleanupStatus" "ArtifactCleanupStatus" NOT NULL DEFAULT 'NOT_REQUIRED';

-- AlterTable
-- The local development table was verified empty before this pre-commit migration.
ALTER TABLE "Project" ADD COLUMN "idempotencyKey" TEXT NOT NULL,
ADD COLUMN "requestFingerprint" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "MediaArtifact_cleanupStatus_updatedAt_idx" ON "MediaArtifact"("cleanupStatus", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_idempotencyKey_key" ON "Project"("idempotencyKey");
