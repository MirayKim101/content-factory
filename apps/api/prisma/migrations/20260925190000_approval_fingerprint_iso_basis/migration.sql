ALTER TABLE "EditorialApproval"
  ADD COLUMN "fingerprintBasisVersion" TEXT;

UPDATE "EditorialApproval"
SET "fingerprintBasisVersion" = 'editorial-approval-fingerprint-v2-date-object-legacy'
WHERE "approvalContractVersion" = 'human-horizontal-approval-v2';

ALTER TABLE "EditorialApproval"
  ADD CONSTRAINT "EditorialApproval_fingerprint_basis_check"
  CHECK (
    ("approvalContractVersion" = 'manual-horizontal-approval-v1' AND "fingerprintBasisVersion" IS NULL)
    OR
    ("approvalContractVersion" = 'human-horizontal-approval-v2' AND "fingerprintBasisVersion" IN (
      'editorial-approval-fingerprint-v2-date-object-legacy',
      'editorial-approval-fingerprint-v2-iso8601'
    ))
  );
