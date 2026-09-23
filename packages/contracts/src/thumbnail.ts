/** Provider-neutral thumbnail candidate metadata. Raw bytes remain private. */
export const THUMBNAIL_CONTRACT_VERSION = "editorial-thumbnail-v1" as const;

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
