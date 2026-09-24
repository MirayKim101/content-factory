/** Provider-neutral thumbnail candidate metadata. Raw bytes remain private. */
export const THUMBNAIL_CONTRACT_VERSION = "editorial-thumbnail-v1" as const;
export const LOCAL_NO_LIKENESS_THUMBNAIL_ADAPTER_VERSION =
  "local-no-likeness-png-v1" as const;
export const LOCAL_NO_LIKENESS_PROMPT_BASIS_VERSION =
  "local-abstract-thumbnail-prompt-v1" as const;
export const NO_LIKENESS_SAFETY_DECISION_VERSION =
  "no-likeness-safety-v1" as const;

export type NoLikenessSafetyDecision = Readonly<{
  version: typeof NO_LIKENESS_SAFETY_DECISION_VERSION;
  realisticPersonRequested: false;
  referenceImageUsed: false;
  externalProviderUsed: false;
}>;

/** Exact public projection for the supported local no-likeness adapter. */
export function projectNoLikenessSafetyDecision(
  value: unknown,
): NoLikenessSafetyDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = [
    "externalProviderUsed",
    "realisticPersonRequested",
    "referenceImageUsed",
    "version",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    row.version !== NO_LIKENESS_SAFETY_DECISION_VERSION ||
    row.realisticPersonRequested !== false ||
    row.referenceImageUsed !== false ||
    row.externalProviderUsed !== false
  )
    return null;
  return {
    version: NO_LIKENESS_SAFETY_DECISION_VERSION,
    realisticPersonRequested: false,
    referenceImageUsed: false,
    externalProviderUsed: false,
  };
}

export type ThumbnailCandidate = Readonly<{
  id: string;
  contractVersion: typeof THUMBNAIL_CONTRACT_VERSION;
  adapterVersion: string;
  promptBasisVersion: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  sizeBytes: number;
  sha256: string;
  likeness: "NONE" | "REFERENCE_CLEARED";
}>;

export function validateThumbnailCandidate(candidate: ThumbnailCandidate): void {
  if (candidate.contractVersion !== THUMBNAIL_CONTRACT_VERSION)
    throw new Error("THUMBNAIL_CONTRACT_INVALID");
  if (!candidate.promptBasisVersion.trim() || !candidate.adapterVersion.trim())
    throw new Error("THUMBNAIL_PROVENANCE_INVALID");
  if (!Number.isInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0)
    throw new Error("THUMBNAIL_SIZE_INVALID");
  if (!/^[0-9a-f]{64}$/.test(candidate.sha256))
    throw new Error("THUMBNAIL_CHECKSUM_INVALID");
}
