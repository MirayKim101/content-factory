ALTER TABLE "PublicationIntent"
  ADD COLUMN "reconciliationLeaseToken" TEXT,
  ADD COLUMN "reconciliationLeaseExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PublicationIntent_reconciliationLeaseToken_key"
  ON "PublicationIntent"("reconciliationLeaseToken");

CREATE INDEX "PublicationIntent_state_reconciliationLeaseExpiresAt_updatedAt_id_idx"
  ON "PublicationIntent"("state", "reconciliationLeaseExpiresAt", "updatedAt", "id");
