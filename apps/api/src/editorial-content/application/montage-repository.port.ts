import type {
  MontageKind,
  StoredMontageAsset,
} from "../domain/montage-asset.js";

export const MONTAGE_REPOSITORY = Symbol("MONTAGE_REPOSITORY");
export interface MontageRepository {
  authorize(
    projectId: string,
  ): Promise<{ sourceId: string; sourceVersion: number }>;
  findReplay(
    projectId: string,
    key: string,
  ): Promise<StoredMontageAsset | null>;
  create(input: {
    id: string;
    projectId: string;
    sourceId: string;
    sourceVersion: number;
    kind: MontageKind;
    idempotencyKey: string;
    requestFingerprint: string;
    objectKey: string;
    originalFilename: string;
    contentType: string;
    sizeBytes: bigint;
    sha256: string;
    width: number | null;
    height: number | null;
    uploadExpiresAt: Date;
  }): Promise<StoredMontageAsset>;
  finalize(
    id: string,
    receipt: { etag?: string; version?: string },
  ): Promise<StoredMontageAsset>;
  inspect(id: string): Promise<StoredMontageAsset | null>;
  get(projectId: string, id: string): Promise<StoredMontageAsset | null>;
  list(
    projectId: string,
    kind: MontageKind | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<StoredMontageAsset[]>;
  recoverable(limit: number): Promise<StoredMontageAsset[]>;
  failUpload(id: string, code: string): Promise<boolean>;
  completeCleanup(id: string): Promise<void>;
  cleanupFailed(id: string): Promise<void>;
}
