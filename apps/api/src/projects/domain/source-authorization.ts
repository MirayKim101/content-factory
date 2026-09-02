export type SourceAuthorizationStatus = "NOT_REVIEWED" | "CLEARED";
export type SourceAuthorizationBasis =
  "LEGACY_ATTESTATION" | "OPERATOR_ATTESTATION";

export interface SourceAuthorizationView {
  sourceVersion: number;
  status: SourceAuthorizationStatus;
  basis?: SourceAuthorizationBasis;
  declarationVersion?: string;
  decidedAt?: Date;
  revision: number;
}

export function isSourceAuthorizationCleared(
  authorization: SourceAuthorizationView | null | undefined,
  sourceVersion: number,
): boolean {
  return (
    authorization?.sourceVersion === sourceVersion &&
    authorization.status === "CLEARED" &&
    authorization.basis !== undefined &&
    authorization.declarationVersion !== undefined &&
    authorization.decidedAt !== undefined
  );
}

export class SourceAuthorizationRequiredError extends Error {
  constructor() {
    super("SOURCE_AUTHORIZATION_REQUIRED");
  }
}
