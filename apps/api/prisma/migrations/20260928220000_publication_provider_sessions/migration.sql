CREATE UNIQUE INDEX "PublicationIntent_id_platform_key"
  ON "PublicationIntent"("id", "platform");

CREATE TABLE "PublicationProviderSession" (
  "publicationIntentId" UUID NOT NULL,
  "platform" "PublicationPlatform" NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "iv" BYTEA NOT NULL,
  "authTag" BYTEA NOT NULL,
  "keyVersion" TEXT NOT NULL,
  "uploadOffset" BIGINT NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PublicationProviderSession_pkey" PRIMARY KEY ("publicationIntentId"),
  CONSTRAINT "PublicationProviderSession_crypto_shape_check"
    CHECK (octet_length("iv") = 12 AND octet_length("authTag") = 16
      AND octet_length("ciphertext") BETWEEN 1 AND 16384),
  CONSTRAINT "PublicationProviderSession_upload_offset_check"
    CHECK ("uploadOffset" >= 0),
  CONSTRAINT "PublicationProviderSession_exact_intent_platform"
    FOREIGN KEY ("publicationIntentId", "platform")
    REFERENCES "PublicationIntent"("id", "platform")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PublicationProviderSession_intent_platform_key"
  ON "PublicationProviderSession"("publicationIntentId", "platform");

CREATE INDEX "PublicationProviderSession_platform_expiresAt_updatedAt_idx"
  ON "PublicationProviderSession"("platform", "expiresAt", "updatedAt");
