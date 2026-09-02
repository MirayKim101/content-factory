ALTER TABLE "PipelineJob"
  ADD COLUMN "sourceVersion" INTEGER;

UPDATE "PipelineJob" AS job
SET "sourceVersion" = source."sourceVersion"
FROM "VideoSource" AS source
WHERE source."id" = job."sourceId";

ALTER TABLE "PipelineJob"
  ALTER COLUMN "sourceVersion" SET NOT NULL,
  ALTER COLUMN "sourceVersion" SET DEFAULT 1;

CREATE INDEX "PipelineJob_sourceId_sourceVersion_idx"
  ON "PipelineJob"("sourceId", "sourceVersion");
