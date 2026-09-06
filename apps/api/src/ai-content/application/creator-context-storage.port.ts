import type { Readable } from "node:stream";

export const CREATOR_CONTEXT_STORAGE = Symbol("CREATOR_CONTEXT_STORAGE");

export interface CreatorContextStorage {
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
  readObject(
    objectKey: string,
    range?: string,
  ): Promise<{
    body: Readable;
    contentLength: number;
    contentType: string;
    contentRange?: string;
    etag?: string;
  } | null>;
}
