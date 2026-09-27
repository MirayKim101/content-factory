CREATE TYPE "TwitchIngestChannelState" AS ENUM ('ENABLED', 'REVOKED');
CREATE TYPE "TwitchEventInboxState" AS ENUM ('RECEIVED', 'PROCESSED', 'REJECTED');
CREATE TYPE "TwitchVodCandidateState" AS ENUM ('WAITING_DELAY', 'READY_FOR_INGEST', 'IMPORTED', 'IGNORED');

CREATE TABLE "TwitchIngestChannel" (
  "id" UUID NOT NULL,
  "broadcasterId" TEXT NOT NULL,
  "broadcasterLogin" TEXT NOT NULL,
  "broadcasterDisplayName" TEXT NOT NULL,
  "state" "TwitchIngestChannelState" NOT NULL DEFAULT 'ENABLED',
  "ingestDelaySeconds" INTEGER NOT NULL DEFAULT 300,
  "reconciliationCursor" TEXT,
  "lastReconciledAt" TIMESTAMP(3),
  "lastOnlineAt" TIMESTAMP(3),
  "lastOfflineAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TwitchIngestChannel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TwitchIngestChannel_delay_check" CHECK ("ingestDelaySeconds" BETWEEN 60 AND 86400),
  CONSTRAINT "TwitchIngestChannel_broadcaster_check" CHECK (length("broadcasterId") BETWEEN 1 AND 64),
  CONSTRAINT "TwitchIngestChannel_login_check" CHECK (length("broadcasterLogin") BETWEEN 1 AND 64)
);

CREATE TABLE "TwitchEventInbox" (
  "id" UUID NOT NULL,
  "messageId" TEXT NOT NULL,
  "channelId" UUID NOT NULL,
  "subscriptionType" TEXT NOT NULL,
  "subscriptionVersion" TEXT NOT NULL,
  "streamId" TEXT,
  "messageTimestamp" TIMESTAMP(3) NOT NULL,
  "payloadSha256" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "state" "TwitchEventInboxState" NOT NULL DEFAULT 'RECEIVED',
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "processedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TwitchEventInbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TwitchEventInbox_type_check" CHECK ("subscriptionType" IN ('stream.online', 'stream.offline')),
  CONSTRAINT "TwitchEventInbox_version_check" CHECK ("subscriptionVersion" = '1'),
  CONSTRAINT "TwitchEventInbox_hash_check" CHECK ("payloadSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "TwitchEventInbox_message_check" CHECK (length("messageId") BETWEEN 1 AND 255)
);

CREATE TABLE "TwitchVodCandidate" (
  "id" UUID NOT NULL,
  "channelId" UUID NOT NULL,
  "providerVideoId" TEXT NOT NULL,
  "streamId" TEXT,
  "title" TEXT NOT NULL,
  "vodType" TEXT NOT NULL,
  "durationSeconds" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3) NOT NULL,
  "availableForIngestAt" TIMESTAMP(3) NOT NULL,
  "state" "TwitchVodCandidateState" NOT NULL DEFAULT 'WAITING_DELAY',
  "importedProjectId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TwitchVodCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TwitchVodCandidate_duration_check" CHECK ("durationSeconds" > 0),
  CONSTRAINT "TwitchVodCandidate_type_check" CHECK ("vodType" IN ('archive', 'highlight', 'upload')),
  CONSTRAINT "TwitchVodCandidate_import_state_check" CHECK (("state" = 'IMPORTED') = ("importedProjectId" IS NOT NULL))
);

CREATE UNIQUE INDEX "TwitchIngestChannel_broadcasterId_key" ON "TwitchIngestChannel"("broadcasterId");
CREATE INDEX "TwitchIngestChannel_state_updatedAt_id_idx" ON "TwitchIngestChannel"("state", "updatedAt", "id");
CREATE UNIQUE INDEX "TwitchEventInbox_messageId_key" ON "TwitchEventInbox"("messageId");
CREATE INDEX "TwitchEventInbox_state_receivedAt_id_idx" ON "TwitchEventInbox"("state", "receivedAt", "id");
CREATE INDEX "TwitchEventInbox_channelId_messageTimestamp_id_idx" ON "TwitchEventInbox"("channelId", "messageTimestamp", "id");
CREATE UNIQUE INDEX "TwitchVodCandidate_providerVideoId_key" ON "TwitchVodCandidate"("providerVideoId");
CREATE INDEX "TwitchVodCandidate_channelId_state_availableForIngestAt_id_idx" ON "TwitchVodCandidate"("channelId", "state", "availableForIngestAt", "id");

ALTER TABLE "TwitchEventInbox" ADD CONSTRAINT "TwitchEventInbox_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "TwitchIngestChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TwitchVodCandidate" ADD CONSTRAINT "TwitchVodCandidate_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "TwitchIngestChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TwitchVodCandidate" ADD CONSTRAINT "TwitchVodCandidate_importedProjectId_fkey"
  FOREIGN KEY ("importedProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
