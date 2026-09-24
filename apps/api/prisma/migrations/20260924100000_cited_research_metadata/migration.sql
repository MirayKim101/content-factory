-- Stage 2B-4a is additive and admission-off by default.
ALTER TYPE "AiContentOperationType" ADD VALUE 'CREATE_RESEARCH_SUGGESTION';

CREATE TYPE "ResearchIntentState" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED_FINAL');
CREATE TYPE "ResearchAttemptState" AS ENUM ('PROCESSING', 'READY', 'FAILED_FINAL');

CREATE TABLE "ResearchSuggestionIntent" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "transcriptIntentId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "cutPipelineJobId" UUID NOT NULL,
    "cutResultArtifactId" UUID NOT NULL,
    "creatorProfileRevisionId" UUID NOT NULL,
    "sourceContextRevisionId" UUID NOT NULL,
    "cutPromptRevisionId" UUID NOT NULL,
    "contextPolicyFingerprint" TEXT NOT NULL,
    "transcriptArtifactId" UUID NOT NULL,
    "transcriptSha256" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "freshnessPolicyVersion" TEXT NOT NULL,
    "searchedAt" TIMESTAMP(3) NOT NULL,
    "freshUntil" TIMESTAMP(3) NOT NULL,
    "state" "ResearchIntentState" NOT NULL DEFAULT 'QUEUED',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchSuggestionIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchCitation" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "accessedAt" TIMESTAMP(3) NOT NULL,
    "excerpt" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchCitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchSuggestionAttempt" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "state" "ResearchAttemptState" NOT NULL DEFAULT 'PROCESSING',
    "leaseToken" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "workDeadlineAt" TIMESTAMP(3) NOT NULL,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchSuggestionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchSuggestionSet" (
    "id" UUID NOT NULL,
    "intentId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" JSONB NOT NULL,
    "claims" JSONB NOT NULL,
    "citationIds" JSONB NOT NULL,
    "basisVersion" TEXT NOT NULL,
    "directCostMicrousd" BIGINT NOT NULL DEFAULT 0,
    "costBasisVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchSuggestionSet_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "EditorialComponentProvenance"
  ADD COLUMN "researchIntentId" UUID,
  ADD COLUMN "suggestionSetId" UUID;

CREATE UNIQUE INDEX "ResearchSuggestionIntent_idempotencyKey_key" ON "ResearchSuggestionIntent"("idempotencyKey");
CREATE INDEX "ResearchSuggestionIntent_transcriptIntentId_createdAt_id_idx" ON "ResearchSuggestionIntent"("transcriptIntentId", "createdAt", "id");
CREATE INDEX "ResearchSuggestionIntent_projectId_state_createdAt_idx" ON "ResearchSuggestionIntent"("projectId", "state", "createdAt");
CREATE UNIQUE INDEX "ResearchCitation_intentId_ordinal_key" ON "ResearchCitation"("intentId", "ordinal");
CREATE UNIQUE INDEX "ResearchCitation_intentId_url_key" ON "ResearchCitation"("intentId", "url");
CREATE UNIQUE INDEX "ResearchSuggestionAttempt_leaseToken_key" ON "ResearchSuggestionAttempt"("leaseToken");
CREATE UNIQUE INDEX "ResearchSuggestionAttempt_intentId_attemptNumber_key" ON "ResearchSuggestionAttempt"("intentId", "attemptNumber");
CREATE INDEX "ResearchSuggestionAttempt_leaseExpiresAt_state_idx" ON "ResearchSuggestionAttempt"("leaseExpiresAt", "state");
CREATE UNIQUE INDEX "ResearchSuggestionSet_intentId_key" ON "ResearchSuggestionSet"("intentId");
CREATE UNIQUE INDEX "ResearchSuggestionSet_attemptId_key" ON "ResearchSuggestionSet"("attemptId");
CREATE INDEX "EditorialComponentProvenance_researchIntentId_idx" ON "EditorialComponentProvenance"("researchIntentId");
CREATE INDEX "EditorialComponentProvenance_suggestionSetId_idx" ON "EditorialComponentProvenance"("suggestionSetId");

ALTER TABLE "ResearchSuggestionIntent" ADD CONSTRAINT "ResearchSuggestionIntent_transcriptIntentId_fkey"
  FOREIGN KEY ("transcriptIntentId") REFERENCES "TranscriptEvidenceIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResearchCitation" ADD CONSTRAINT "ResearchCitation_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "ResearchSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResearchSuggestionAttempt" ADD CONSTRAINT "ResearchSuggestionAttempt_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "ResearchSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResearchSuggestionSet" ADD CONSTRAINT "ResearchSuggestionSet_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "ResearchSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResearchSuggestionSet" ADD CONSTRAINT "ResearchSuggestionSet_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "ResearchSuggestionAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialComponentProvenance" ADD CONSTRAINT "EditorialComponentProvenance_researchIntentId_fkey"
  FOREIGN KEY ("researchIntentId") REFERENCES "ResearchSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialComponentProvenance" ADD CONSTRAINT "EditorialComponentProvenance_suggestionSetId_fkey"
  FOREIGN KEY ("suggestionSetId") REFERENCES "ResearchSuggestionSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
