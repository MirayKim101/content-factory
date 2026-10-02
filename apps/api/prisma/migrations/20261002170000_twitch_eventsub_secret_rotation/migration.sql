CREATE TABLE "TwitchEventSubReconciliationState" (
  "id" TEXT NOT NULL,
  "appliedSecretVersion" TEXT,
  "rotationLeaseOwner" TEXT,
  "rotationLeaseExpiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TwitchEventSubReconciliationState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TwitchEventSubReconciliationState_id_check"
    CHECK ("id" = 'webhook'),
  CONSTRAINT "TwitchEventSubReconciliationState_version_check"
    CHECK (
      "appliedSecretVersion" IS NULL
      OR "appliedSecretVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ),
  CONSTRAINT "TwitchEventSubReconciliationState_lease_check"
    CHECK (
      ("rotationLeaseOwner" IS NULL) = ("rotationLeaseExpiresAt" IS NULL)
    )
);
