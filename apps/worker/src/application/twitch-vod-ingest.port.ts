export interface TwitchVodIngestLease {
  id: string;
  candidateId: string;
  providerVideoId: string;
  projectName: string;
  attemptCount: number;
  leaseOwner: string;
  downloadedBytes: bigint;
  totalBytes: bigint | null;
}

export interface TwitchVodIngestRepository {
  claimNext(
    workerId: string,
    leaseMs: number,
  ): Promise<TwitchVodIngestLease | null>;
  heartbeat(id: string, workerId: string, leaseMs: number): Promise<boolean>;
  release(id: string, workerId: string): Promise<boolean>;
  checkpoint(
    id: string,
    workerId: string,
    downloaded: bigint,
    total: bigint,
  ): Promise<void>;
  beginUpload(
    id: string,
    workerId: string,
    objectKey: string,
    sha256: string,
  ): Promise<void>;
  complete(input: {
    intentId: string;
    workerId: string;
    projectId: string;
    sourceId: string;
    artifactId: string;
    objectKey: string;
    sizeBytes: bigint;
    sha256: string;
    etag?: string;
    version?: string;
  }): Promise<void>;
  fail(
    id: string,
    workerId: string,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<void>;
}
