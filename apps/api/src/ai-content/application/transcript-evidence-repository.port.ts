import type {
  TranscriptEvidenceView,
  TranscriptInputCapture,
  TranscriptSegment,
} from "@content-factory/contracts";
import type { LocalTranscriptFixture } from "../transcript/local-transcript-adapter.js";

export const TRANSCRIPT_EVIDENCE_REPOSITORY = Symbol(
  "TRANSCRIPT_EVIDENCE_REPOSITORY",
);

export interface TranscriptClaim {
  intentId: string;
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  workDeadlineAt: Date;
  input: TranscriptInputCapture;
  fixture: LocalTranscriptFixture;
}

export interface TranscriptEvidenceRepository {
  create(input: {
    cutPipelineJobId: string;
    sourceContextRevisionId: string;
    cutPromptRevisionId: string;
    idempotencyKey: string;
    language: string;
    fixture: LocalTranscriptFixture;
  }): Promise<string>;
  detail(intentId: string): Promise<TranscriptEvidenceView | null>;
  content(intentId: string): Promise<{
    objectKey: string;
    sizeBytes: number;
    sha256: string;
  } | null>;
  claim(intentId: string, workerId: string): Promise<TranscriptClaim | null>;
  complete(input: {
    claim: TranscriptClaim;
    artifact: {
      id: string;
      objectKey: string;
      contentType: "application/json";
      sizeBytes: number;
      sha256: string;
      adapterVersion: string;
      language: string;
      segments: readonly TranscriptSegment[];
    };
  }): Promise<boolean>;
  fail(input: {
    claim: TranscriptClaim;
    code: string;
    message: string;
    retryable: boolean;
  }): Promise<void>;
}

export class TranscriptContextRejectedError extends Error {
  constructor(readonly blockers: readonly string[]) {
    super("TRANSCRIPT_CONTEXT_REQUIRED");
  }
}
