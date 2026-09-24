-- Preserve the exact cut range in the immutable thumbnail input capture.
ALTER TABLE "ImageSuggestionIntent"
  ADD COLUMN "cutStartMs" INTEGER,
  ADD COLUMN "cutEndMs" INTEGER;

UPDATE "ImageSuggestionIntent" i
   SET "cutStartMs" = s."startMs",
       "cutEndMs" = s."endMs"
  FROM "CutSegment" s
 WHERE s."jobId" = i."cutPipelineJobId";

ALTER TABLE "ImageSuggestionIntent"
  ALTER COLUMN "cutStartMs" SET NOT NULL,
  ALTER COLUMN "cutEndMs" SET NOT NULL,
  ADD CONSTRAINT "ImageSuggestionIntent_cut_bounds"
    CHECK ("cutStartMs" >= 0 AND "cutEndMs" > "cutStartMs");
