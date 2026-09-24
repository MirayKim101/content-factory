-- The original regular expression used a doubled backslash in a PostgreSQL
-- standard string and rejected the worker's canonical transcript.json key.
ALTER TABLE "TranscriptEvidenceArtifact"
  DROP CONSTRAINT "TranscriptEvidenceArtifact_private_key_check";

ALTER TABLE "TranscriptEvidenceArtifact"
  ADD CONSTRAINT "TranscriptEvidenceArtifact_private_key_check"
  CHECK ("objectKey" ~ '^ai-content/transcripts/[0-9a-f-]{36}/transcript[.]json$');
