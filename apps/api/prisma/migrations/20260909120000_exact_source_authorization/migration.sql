BEGIN;

LOCK TABLE "Project", "VideoSource" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "VideoSource" source
    JOIN "Project" project ON project."id" = source."projectId"
    WHERE project."rightsConfirmedAt" IS NULL
       OR project."rightsDeclarationVersion" IS NULL
       OR btrim(project."rightsDeclarationVersion") = ''
       OR source."sourceVersion" <= 0
       OR source."sha256" !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'SOURCE_AUTHORIZATION_LEGACY_DATA_INVALID';
  END IF;
END $$;

CREATE TYPE "SourceAuthorizationStatus" AS ENUM ('NOT_REVIEWED', 'CLEARED');
CREATE TYPE "SourceAuthorizationBasis" AS ENUM ('EXPLICIT_CONFIRMATION', 'LEGACY_ATTESTATION');

CREATE TABLE "SourceAuthorization" (
  "sourceId" UUID NOT NULL,
  "sourceVersion" INTEGER NOT NULL,
  "sourceSha256" CHAR(64) NOT NULL,
  "status" "SourceAuthorizationStatus" NOT NULL DEFAULT 'NOT_REVIEWED',
  "basis" "SourceAuthorizationBasis",
  "confirmedAt" TIMESTAMP(3),
  "declarationVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SourceAuthorization_pkey" PRIMARY KEY ("sourceId", "sourceVersion"),
  CONSTRAINT "SourceAuthorization_sourceVersion_check" CHECK ("sourceVersion" > 0),
  CONSTRAINT "SourceAuthorization_sourceSha256_check" CHECK ("sourceSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "SourceAuthorization_state_check" CHECK (
    ("status" = 'NOT_REVIEWED' AND "basis" IS NULL AND "confirmedAt" IS NULL AND "declarationVersion" IS NULL)
    OR
    ("status" = 'CLEARED' AND "basis" IS NOT NULL AND "confirmedAt" IS NOT NULL AND "declarationVersion" IS NOT NULL AND btrim("declarationVersion") <> '')
  )
);

INSERT INTO "SourceAuthorization" (
  "sourceId",
  "sourceVersion",
  "sourceSha256",
  "status",
  "basis",
  "confirmedAt",
  "declarationVersion",
  "createdAt",
  "updatedAt"
)
SELECT
  source."id",
  source."sourceVersion",
  source."sha256",
  'CLEARED'::"SourceAuthorizationStatus",
  'LEGACY_ATTESTATION'::"SourceAuthorizationBasis",
  project."rightsConfirmedAt",
  project."rightsDeclarationVersion",
  project."createdAt",
  GREATEST(project."updatedAt", project."rightsConfirmedAt")
FROM "VideoSource" source
JOIN "Project" project ON project."id" = source."projectId";

DO $$
DECLARE
  source_count BIGINT;
  authorization_count BIGINT;
BEGIN
  SELECT count(*) INTO source_count FROM "VideoSource";
  SELECT count(*) INTO authorization_count FROM "SourceAuthorization";
  IF source_count <> authorization_count THEN
    RAISE EXCEPTION 'SOURCE_AUTHORIZATION_BACKFILL_COUNT_MISMATCH: sources=%, authorizations=%', source_count, authorization_count;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "VideoSource" source
    LEFT JOIN "SourceAuthorization" auth
      ON auth."sourceId" = source."id"
     AND auth."sourceVersion" = source."sourceVersion"
    WHERE auth."sourceId" IS NULL
       OR auth."sourceSha256" <> source."sha256"
       OR auth."status" <> 'CLEARED'
       OR auth."basis" <> 'LEGACY_ATTESTATION'
  ) THEN
    RAISE EXCEPTION 'SOURCE_AUTHORIZATION_BACKFILL_VERIFICATION_FAILED';
  END IF;
END $$;

ALTER TABLE "Project"
  ALTER COLUMN "rightsConfirmedAt" DROP NOT NULL,
  ALTER COLUMN "rightsDeclarationVersion" DROP NOT NULL;

CREATE INDEX "SourceAuthorization_exact_clearance_idx"
  ON "SourceAuthorization"("sourceId", "sourceVersion", "sourceSha256", "status");

ALTER TABLE "SourceAuthorization"
  ADD CONSTRAINT "SourceAuthorization_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "VideoSource"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
