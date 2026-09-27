export interface VerticalRenderClaim {
  jobId: string;
  intentId: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  inputObjectKey: string;
  inputSizeBytes: bigint;
  expectedDurationMs: number;
  leaseToken: string;
  attemptNumber: number;
  retryBudget: number;
}

export interface VerticalRenderedFile {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  ffmpegVersion: string;
}

export interface VerticalRenderRepository {
  claim(jobId: string, leaseMs: number): Promise<VerticalRenderClaim | null>;
  heartbeat(claim: VerticalRenderClaim, leaseMs: number): Promise<boolean>;
  complete(
    claim: VerticalRenderClaim,
    output: VerticalRenderedFile & {
      objectKey: string;
      sizeBytes: bigint;
      sha256: string;
      etag?: string;
      storageVersion?: string;
    },
  ): Promise<boolean>;
  fail(
    claim: VerticalRenderClaim,
    code: string,
    message: string,
  ): Promise<void>;
  due(limit?: number): Promise<string[]>;
  close(): Promise<void>;
}

export interface VerticalRenderer {
  render(
    input: string,
    output: string,
    signal: AbortSignal,
  ): Promise<VerticalRenderedFile>;
  verifyAvailable(): Promise<void>;
}
