export type PipelineJobState =
  "QUEUED" | "PROCESSING" | "RETRY_WAIT" | "READY" | "FAILED_FINAL";

export interface PipelineJobView {
  id: string;
  clientSegmentId: string;
  revision: number;
  state: PipelineJobState;
  startMs: number;
  endMs: number;
  processedMs?: number;
  totalMs?: number;
  attempt: number;
  retryBudget: number;
  failure?: { code: string; message: string; retryable: boolean };
  result?: { filename: string; sizeBytes: bigint; sha256: string };
  updatedAt: Date;
}

export interface CutSegmentIntent {
  clientSegmentId: string;
  startMs: number;
  endMs: number;
}

export interface CreateCutsResult {
  requestId: string;
  projectId: string;
  jobs: PipelineJobView[];
}
