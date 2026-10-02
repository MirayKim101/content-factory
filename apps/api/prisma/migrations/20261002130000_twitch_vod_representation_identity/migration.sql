ALTER TABLE "TwitchVodIngestIntent"
ADD COLUMN "representationEtag" TEXT;

ALTER TABLE "TwitchVodIngestIntent"
ADD CONSTRAINT "TwitchVodIngestIntent_representationEtag_check"
CHECK (
  "representationEtag" IS NULL
  OR (
    length("representationEtag") BETWEEN 3 AND 200
    AND "representationEtag" NOT LIKE 'W/%'
    AND "representationEtag" ~ '^"[!#-~]+"$'
  )
);
