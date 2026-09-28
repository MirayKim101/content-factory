export interface PublicationMediaIdentity {
  objectKey: string;
  storageVersion?: string | null;
  sizeBytes: bigint;
  sha256: string;
  contentType: string;
}

export interface PublicationMediaSource {
  verifyIdentity(
    identity: PublicationMediaIdentity,
    signal?: AbortSignal,
  ): Promise<void>;
  readRange(input: {
    identity: PublicationMediaIdentity;
    offset: bigint;
    length: number;
    signal?: AbortSignal;
  }): Promise<Buffer>;
}
