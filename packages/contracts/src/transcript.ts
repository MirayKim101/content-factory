/** Provider-neutral transcript evidence contract. Raw provider payloads never cross this boundary. */
export const TRANSCRIPT_CONTRACT_VERSION = "editorial-transcript-v1" as const;
export const LOCAL_TRANSCRIPT_ADAPTER_VERSION =
  "local-manual-transcript-v1" as const;

export type TranscriptState =
  "QUEUED" | "PROCESSING" | "READY" | "FAILED_FINAL";

export type TranscriptSegment = Readonly<{
  ordinal: number;
  startMs: number;
  endMs: number;
  text: string;
}>;

export type TranscriptInputCapture = Readonly<{
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceSha256: string;
  sourceAuthorizationRevision: number;
  cutPipelineJobId: string;
  cutResultArtifactId: string;
  cutResultSha256: string;
  cutResultSizeBytes: string;
  cutStartMs: number;
  cutEndMs: number;
  creatorProfileRevisionId: string;
  creatorProfileRevisionNo: number;
  sourceContextRevisionId: string;
  sourceContextRevisionNo: number;
  cutPromptRevisionId: string;
  cutPromptRevisionNo: number;
}>;

export type TranscriptArtifact = Readonly<{
  id: string;
  contentType: "application/json";
  sizeBytes: number;
  sha256: string;
  adapterVersion: string;
  language: string;
  segments: readonly TranscriptSegment[];
}>;

export type TranscriptEvidenceView = Readonly<{
  id: string;
  state: TranscriptState;
  contractVersion: typeof TRANSCRIPT_CONTRACT_VERSION;
  adapterVersion: string;
  language: string;
  input: TranscriptInputCapture;
  artifact: TranscriptArtifact | null;
  failure: Readonly<{ code: string; message: string }> | null;
}>;

export function validateTranscriptSegments(
  segments: readonly TranscriptSegment[],
  durationMs: number,
): void {
  if (!Number.isInteger(durationMs) || durationMs < 1)
    throw new Error("TRANSCRIPT_DURATION_INVALID");
  let previousEnd = 0;
  segments.forEach((segment, ordinal) => {
    if (
      segment.ordinal !== ordinal ||
      !Number.isInteger(segment.startMs) ||
      !Number.isInteger(segment.endMs) ||
      segment.startMs < 0 ||
      segment.endMs <= segment.startMs ||
      segment.endMs > durationMs ||
      segment.startMs < previousEnd ||
      !segment.text.trim() ||
      segment.text.length > 20_000
    ) {
      throw new Error("TRANSCRIPT_SEGMENTS_INVALID");
    }
    previousEnd = segment.endMs;
  });
}
