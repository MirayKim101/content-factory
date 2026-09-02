import type { Readable } from "node:stream";

export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

export class ObjectRangeNotSatisfiableError extends Error {
  constructor() {
    super("OBJECT_RANGE_NOT_SATISFIABLE");
  }
}

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
  readObject?(
    objectKey: string,
    range?: string,
    signal?: AbortSignal,
  ): Promise<{
    body: Readable;
    contentLength: number;
    contentType: string;
    contentRange?: string;
    etag?: string;
  } | null>;
}
