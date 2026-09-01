export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

export interface StoredObject {
  etag?: string;
  version?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface ObjectStorage {
  ensurePrivateBucket(): Promise<void>;
  putFile(input: {
    objectKey: string;
    filePath: string;
    contentType: string;
    sha256: string;
    signal?: AbortSignal;
  }): Promise<StoredObject>;
  headObject(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<StoredObject | null>;
  deleteObject(objectKey: string, signal?: AbortSignal): Promise<void>;
}
