ALTER TABLE "PublicationIntent"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX "PublicationIntent_state_nextAttemptAt_scheduledAt_id_idx"
  ON "PublicationIntent"("state", "nextAttemptAt", "scheduledAt", "id");
