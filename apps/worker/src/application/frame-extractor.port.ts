import type { FrameMeasurement } from "@content-factory/contracts";

export interface FrameExtractionRequest {
  sourcePath: string;
  outputDirectory: string;
  cutStartMs: number;
  cutEndMs: number;
  inputSizeBytes: number;
  workDeadlineAt: Date;
  signal: AbortSignal;
  onMeasuredProgress(
    phase: "EXTRACT" | "HASH",
    completedFrames: number,
  ): Promise<void>;
}

export interface ExtractedFrame {
  filePath: string;
  measurement: FrameMeasurement;
}

export interface FrameExtractor {
  verifyAvailable(): Promise<void>;
  /** Resolves/rejects only once all child processes have exited. */
  extract(request: FrameExtractionRequest): Promise<readonly ExtractedFrame[]>;
}
