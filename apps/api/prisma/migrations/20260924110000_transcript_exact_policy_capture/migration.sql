-- Preserve the full authorization/context policy material needed to prove that
-- a transcript still belongs to the exact context captured at admission.
ALTER TABLE "TranscriptEvidenceIntent"
  ADD COLUMN "sourceAuthorizationBasis" TEXT,
  ADD COLUMN "sourceAuthorizationDeclarationVersion" TEXT,
  ADD COLUMN "sourceAuthorizationDecidedAt" TIMESTAMP(3),
  ADD COLUMN "creatorProfileId" UUID,
  ADD COLUMN "sourceContextId" UUID,
  ADD COLUMN "cutPromptId" UUID;

UPDATE "TranscriptEvidenceIntent" AS t
SET
  "sourceAuthorizationBasis" = sa."basis"::text,
  "sourceAuthorizationDeclarationVersion" = sa."declarationVersion",
  "sourceAuthorizationDecidedAt" = sa."decidedAt",
  "creatorProfileId" = cpr."creatorProfileId",
  "sourceContextId" = scr."contextId",
  "cutPromptId" = pr."promptId"
FROM "SourceAuthorization" AS sa,
     "CreatorProfileRevision" AS cpr,
     "SourceEditorialContextRevision" AS scr,
     "CutEditorialPromptRevision" AS pr
WHERE sa."sourceId" = t."sourceId"
  AND sa."sourceVersion" = t."sourceVersion"
  AND sa."revision" = t."sourceAuthorizationRevision"
  AND cpr."id" = t."creatorProfileRevisionId"
  AND scr."id" = t."sourceContextRevisionId"
  AND pr."id" = t."cutPromptRevisionId";

-- A legacy transcript whose captured authorization revision is no longer the
-- current row cannot be reconstructed honestly. Its nullable policy fields
-- intentionally remain empty, so every later currentness gate rejects it as
-- stale. New intents always write all six fields atomically at admission.
