CREATE TYPE "PublicationContentKind" AS ENUM ('EDITORIAL_EXPORT', 'VERTICAL_RESULT');

ALTER TABLE "PublicationIntent"
  ADD COLUMN "contentKind" "PublicationContentKind" NOT NULL DEFAULT 'EDITORIAL_EXPORT',
  ADD COLUMN "verticalApprovalId" UUID,
  ADD COLUMN "verticalResultId" UUID,
  ALTER COLUMN "approvalId" DROP NOT NULL,
  ALTER COLUMN "exportIntentId" DROP NOT NULL,
  ALTER COLUMN "exportResultId" DROP NOT NULL;

ALTER TABLE "PublicationIntent"
  ADD CONSTRAINT "PublicationIntent_vertical_approval"
    FOREIGN KEY ("verticalApprovalId") REFERENCES "VerticalApproval"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PublicationIntent_vertical_result"
    FOREIGN KEY ("verticalResultId") REFERENCES "VerticalRenderResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PublicationIntent_exactly_one_lineage" CHECK (
    ("contentKind" = 'EDITORIAL_EXPORT' AND "approvalId" IS NOT NULL AND "exportIntentId" IS NOT NULL AND "exportResultId" IS NOT NULL AND "verticalApprovalId" IS NULL AND "verticalResultId" IS NULL)
    OR
    ("contentKind" = 'VERTICAL_RESULT' AND "approvalId" IS NULL AND "exportIntentId" IS NULL AND "exportResultId" IS NULL AND "verticalApprovalId" IS NOT NULL AND "verticalResultId" IS NOT NULL)
  );

CREATE UNIQUE INDEX "PublicationIntent_vertical_target_key"
  ON "PublicationIntent"("channelId", "verticalResultId", "platform");
