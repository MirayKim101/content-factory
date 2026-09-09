export const MONTAGE_KINDS = [
  "ADVERTISEMENT",
  "INTRO",
  "OUTRO",
  "BANNER",
] as const;
export type MontageKind = (typeof MONTAGE_KINDS)[number];
export const MONTAGE_MAX_BYTES = 256 * 1024 * 1024;
export const MONTAGE_UPLOAD_TIMEOUT_MS = 120_000;
export const MONTAGE_RIGHTS_DECLARATION = "montage-local-development-auto-v1";

export class MontageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface MontageAsset {
  id: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  kind: MontageKind;
  status: "UPLOADING" | "PROBE_PENDING" | "READY" | "FAILED_FINAL";
  revision: number;
  originalFilename: string;
  contentType: string;
  sizeBytes: bigint;
  sha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  hasAudio: boolean | null;
  probeJob: {
    id: string;
    state: string;
    revision: number;
    attemptCount: number;
    retryBudget: number;
    failureCode: string | null;
    failureMessage: string | null;
    failureRetryable: boolean | null;
  } | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredMontageAsset extends MontageAsset {
  objectKey: string;
  requestFingerprint: string;
  cleanupStatus: "NOT_REQUIRED" | "PENDING" | "COMPLETED";
  uploadExpiresAt: Date;
}

export function montageRightsUsable(
  asset: {
    rightsBasis: string;
    rightsDeclaration: string;
    rightsDecidedAt: Date | null;
  },
  policy: string,
): boolean {
  return (
    policy === "local-auto" &&
    asset.rightsBasis === "LOCAL_DEVELOPMENT_AUTO" &&
    asset.rightsDeclaration === MONTAGE_RIGHTS_DECLARATION &&
    asset.rightsDecidedAt instanceof Date
  );
}
