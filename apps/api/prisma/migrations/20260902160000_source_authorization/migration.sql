CREATE TYPE "SourceAuthorizationStatus" AS ENUM ('NOT_REVIEWED', 'CLEARED');
CREATE TYPE "SourceAuthorizationBasis" AS ENUM ('LEGACY_ATTESTATION', 'OPERATOR_ATTESTATION');

CREATE TABLE "SourceAuthorization" (
    "sourceId" UUID NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "status" "SourceAuthorizationStatus" NOT NULL DEFAULT 'NOT_REVIEWED',
    "basis" "SourceAuthorizationBasis",
    "declarationVersion" TEXT,
    "decidedAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceAuthorization_pkey" PRIMARY KEY ("sourceId", "sourceVersion"),
    CONSTRAINT "SourceAuthorization_decision_fields_check" CHECK (
      ("status" = 'NOT_REVIEWED' AND "basis" IS NULL AND "declarationVersion" IS NULL AND "decidedAt" IS NULL)
      OR
      ("status" = 'CLEARED' AND "basis" IS NOT NULL AND "declarationVersion" IS NOT NULL AND "decidedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "SourceAuthorization_sourceId_sourceVersion_key"
  ON "SourceAuthorization"("sourceId", "sourceVersion");
CREATE INDEX "SourceAuthorization_status_updatedAt_idx"
  ON "SourceAuthorization"("status", "updatedAt");
ALTER TABLE "SourceAuthorization"
  ADD CONSTRAINT "SourceAuthorization_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "VideoSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "SourceAuthorization" (
  "sourceId", "sourceVersion", "status", "basis", "declarationVersion", "decidedAt", "createdAt", "updatedAt"
)
SELECT source.id, source."sourceVersion", 'CLEARED', 'LEGACY_ATTESTATION',
       project."rightsDeclarationVersion", project."rightsConfirmedAt", source."createdAt", CURRENT_TIMESTAMP
FROM "VideoSource" source
JOIN "Project" project ON project.id = source."projectId";

ALTER TABLE "Project" ALTER COLUMN "rightsConfirmedAt" DROP NOT NULL;
ALTER TABLE "Project" ALTER COLUMN "rightsDeclarationVersion" DROP NOT NULL;
