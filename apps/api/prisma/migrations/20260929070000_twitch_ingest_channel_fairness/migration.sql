ALTER TABLE "TwitchIngestChannel"
ADD COLUMN "lastIngestClaimedAt" TIMESTAMP(3);

CREATE INDEX "TwitchIngestChannel_state_lastIngestClaimedAt_id_idx"
ON "TwitchIngestChannel"("state", "lastIngestClaimedAt", "id");
