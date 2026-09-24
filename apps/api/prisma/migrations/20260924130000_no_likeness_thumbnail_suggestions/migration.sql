-- Stage 2B-5a is additive and admission-off by default.
ALTER TYPE "AiContentOperationType" ADD VALUE 'CREATE_IMAGE_SUGGESTION';

CREATE TYPE "ImageSuggestionState" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED_FINAL');
CREATE TYPE "ImageSuggestionAttemptState" AS ENUM ('PROCESSING', 'READY', 'FAILED_FINAL');

CREATE TABLE "ImageSuggestionIntent" (
    "id" UUID NOT NULL, "idempotencyKey" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
    "projectId" UUID NOT NULL, "sourceId" UUID NOT NULL, "sourceVersion" INTEGER NOT NULL,
    "sourceSha256" TEXT NOT NULL, "sourceAuthorizationRevision" INTEGER NOT NULL,
    "sourceAuthorizationBasis" TEXT NOT NULL, "sourceAuthorizationDeclarationVersion" TEXT NOT NULL,
    "sourceAuthorizationDecidedAt" TIMESTAMP(3) NOT NULL, "cutPipelineJobId" UUID NOT NULL,
    "cutResultArtifactId" UUID NOT NULL, "cutResultSha256" TEXT NOT NULL, "cutResultSizeBytes" BIGINT NOT NULL,
    "creatorProfileId" UUID NOT NULL, "creatorProfileRevisionId" UUID NOT NULL,
    "creatorProfileRevisionNo" INTEGER NOT NULL, "sourceContextId" UUID NOT NULL,
    "sourceContextRevisionId" UUID NOT NULL, "sourceContextRevisionNo" INTEGER NOT NULL,
    "cutPromptId" UUID NOT NULL, "cutPromptRevisionId" UUID NOT NULL, "cutPromptRevisionNo" INTEGER NOT NULL,
    "contextPolicyFingerprint" TEXT NOT NULL, "contractVersion" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL, "promptBasisVersion" TEXT NOT NULL,
    "state" "ImageSuggestionState" NOT NULL DEFAULT 'QUEUED', "failureCode" TEXT,
    "failureMessage" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImageSuggestionIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImageSuggestionAttempt" (
    "id" UUID NOT NULL, "intentId" UUID NOT NULL, "attemptNumber" INTEGER NOT NULL,
    "state" "ImageSuggestionAttemptState" NOT NULL DEFAULT 'PROCESSING', "leaseToken" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL, "workDeadlineAt" TIMESTAMP(3) NOT NULL,
    "failureCode" TEXT, "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImageSuggestionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImageSuggestionCandidate" (
    "id" UUID NOT NULL, "intentId" UUID NOT NULL, "attemptId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL, "contentType" TEXT NOT NULL, "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL, "width" INTEGER NOT NULL, "height" INTEGER NOT NULL,
    "storageEtag" TEXT, "storageVersion" TEXT, "contractVersion" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL, "promptBasisVersion" TEXT NOT NULL,
    "likeness" TEXT NOT NULL DEFAULT 'NONE', "safetyDecision" JSONB NOT NULL,
    "directCostMicrousd" BIGINT NOT NULL DEFAULT 0, "costBasisVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImageSuggestionCandidate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImageSuggestionCandidate_png_only" CHECK ("contentType" = 'image/png'),
    CONSTRAINT "ImageSuggestionCandidate_no_likeness" CHECK ("likeness" = 'NONE'),
    CONSTRAINT "ImageSuggestionCandidate_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "ImageSuggestionCandidate_positive_geometry" CHECK ("sizeBytes" > 0 AND "width" > 0 AND "height" > 0)
);

ALTER TABLE "EditorialComponentProvenance"
  ADD COLUMN "imageIntentId" UUID,
  ADD COLUMN "imageCandidateId" UUID;

CREATE UNIQUE INDEX "ImageSuggestionIntent_idempotencyKey_key" ON "ImageSuggestionIntent"("idempotencyKey");
CREATE INDEX "ImageSuggestionIntent_cutPipelineJobId_createdAt_id_idx" ON "ImageSuggestionIntent"("cutPipelineJobId", "createdAt", "id");
CREATE INDEX "ImageSuggestionIntent_projectId_state_createdAt_idx" ON "ImageSuggestionIntent"("projectId", "state", "createdAt");
CREATE UNIQUE INDEX "ImageSuggestionAttempt_leaseToken_key" ON "ImageSuggestionAttempt"("leaseToken");
CREATE UNIQUE INDEX "ImageSuggestionAttempt_intentId_attemptNumber_key" ON "ImageSuggestionAttempt"("intentId", "attemptNumber");
CREATE INDEX "ImageSuggestionAttempt_leaseExpiresAt_state_idx" ON "ImageSuggestionAttempt"("leaseExpiresAt", "state");
CREATE UNIQUE INDEX "ImageSuggestionCandidate_intentId_key" ON "ImageSuggestionCandidate"("intentId");
CREATE UNIQUE INDEX "ImageSuggestionCandidate_attemptId_key" ON "ImageSuggestionCandidate"("attemptId");
CREATE UNIQUE INDEX "ImageSuggestionCandidate_objectKey_key" ON "ImageSuggestionCandidate"("objectKey");
CREATE INDEX "EditorialComponentProvenance_imageIntentId_idx" ON "EditorialComponentProvenance"("imageIntentId");
CREATE INDEX "EditorialComponentProvenance_imageCandidateId_idx" ON "EditorialComponentProvenance"("imageCandidateId");

ALTER TABLE "ImageSuggestionAttempt" ADD CONSTRAINT "ImageSuggestionAttempt_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "ImageSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImageSuggestionCandidate" ADD CONSTRAINT "ImageSuggestionCandidate_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "ImageSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImageSuggestionCandidate" ADD CONSTRAINT "ImageSuggestionCandidate_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "ImageSuggestionAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialComponentProvenance" ADD CONSTRAINT "EditorialComponentProvenance_imageIntentId_fkey"
  FOREIGN KEY ("imageIntentId") REFERENCES "ImageSuggestionIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditorialComponentProvenance" ADD CONSTRAINT "EditorialComponentProvenance_imageCandidateId_fkey"
  FOREIGN KEY ("imageCandidateId") REFERENCES "ImageSuggestionCandidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
