export type SourceAuthorizationStatus = "NOT_REVIEWED" | "CLEARED";
export type SourceAuthorizationBasis =
  "LEGACY_ATTESTATION" | "OPERATOR_ATTESTATION" | "LOCAL_DEVELOPMENT_AUTO";

export type SourceAuthorizationPolicy = "manual" | "local-auto";

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
  policy: SourceAuthorizationPolicy = "manual",
): boolean {
  return (
    authorization?.sourceVersion === sourceVersion &&
    authorization.status === "CLEARED" &&
    authorization.basis !== undefined &&
    (authorization.basis !== "LOCAL_DEVELOPMENT_AUTO" ||
      policy === "local-auto") &&
    authorization.declarationVersion !== undefined &&
    authorization.decidedAt !== undefined
  );
}

export class SourceAuthorizationRequiredError extends Error {
  constructor() {
    super("SOURCE_AUTHORIZATION_REQUIRED");
  }
}
