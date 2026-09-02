import type { Readable } from "node:stream";

export const EDITORIAL_STORAGE = Symbol("EDITORIAL_STORAGE");

export interface EditorialStorage {
  putFile(input: {
    objectKey: string;
    filePath: string;
    contentType: string;
    sha256: string;
  }): Promise<{ etag?: string; version?: string }>;
  deleteObject(objectKey: string): Promise<void>;
  headObject(objectKey: string): Promise<{
    etag?: string;
    version?: string;
    sizeBytes?: number;
    sha256?: string;
  } | null>;
  readObject(objectKey: string): Promise<{
    body: Readable;
    contentLength: number;
    contentType: string;
    etag?: string;
  } | null>;
}
