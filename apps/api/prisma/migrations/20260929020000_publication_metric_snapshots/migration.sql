ALTER TABLE "PublicationIntent"
  ADD COLUMN "metricsLeaseToken" TEXT,
  ADD COLUMN "metricsLeaseExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PublicationIntent_metricsLeaseToken_key"
  ON "PublicationIntent"("metricsLeaseToken");
CREATE INDEX "PublicationIntent_state_metricsLeaseExpiresAt_updatedAt_id_idx"
  ON "PublicationIntent"("state", "metricsLeaseExpiresAt", "updatedAt", "id");

CREATE TABLE "PublicationMetricSnapshot" (
  "id" UUID NOT NULL,
  "publicationIntentId" UUID NOT NULL,
  "platform" "PublicationPlatform" NOT NULL,
  "viewCount" BIGINT NOT NULL,
  "likeCount" BIGINT,
  "commentCount" BIGINT,
  "shareCount" BIGINT,
  "adapterVersion" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicationMetricSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublicationMetricSnapshot_publicationIntentId_fkey"
    FOREIGN KEY ("publicationIntentId") REFERENCES "PublicationIntent"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PublicationMetricSnapshot_publicationIntentId_observedAt_key"
  ON "PublicationMetricSnapshot"("publicationIntentId", "observedAt");
CREATE INDEX "PublicationMetricSnapshot_publicationIntentId_observedAt_idx"
  ON "PublicationMetricSnapshot"("publicationIntentId", "observedAt" DESC);
CREATE INDEX "PublicationMetricSnapshot_platform_observedAt_idx"
  ON "PublicationMetricSnapshot"("platform", "observedAt");
