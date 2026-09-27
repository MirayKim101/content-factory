CREATE TABLE "ClipGenerationAcceptance" (
  "id" UUID NOT NULL,
  "intentId" UUID NOT NULL,
  "cutRequestId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "suggestionIds" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClipGenerationAcceptance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClipGenerationAcceptance_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "ClipGenerationIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ClipGenerationAcceptance_cutRequestId_fkey" FOREIGN KEY ("cutRequestId") REFERENCES "CutRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ClipGenerationAcceptance_suggestionIds_check" CHECK (jsonb_typeof("suggestionIds") = 'array' AND jsonb_array_length("suggestionIds") BETWEEN 1 AND 20)
);

CREATE UNIQUE INDEX "ClipGenerationAcceptance_cutRequestId_key" ON "ClipGenerationAcceptance"("cutRequestId");
CREATE UNIQUE INDEX "ClipGenerationAcceptance_idempotencyKey_key" ON "ClipGenerationAcceptance"("idempotencyKey");
CREATE INDEX "ClipGenerationAcceptance_intentId_createdAt_id_idx" ON "ClipGenerationAcceptance"("intentId", "createdAt", "id");
