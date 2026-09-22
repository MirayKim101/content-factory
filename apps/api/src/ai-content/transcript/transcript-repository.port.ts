import type {
  TranscriptEvidenceView,
  TranscriptInputCapture,
} from "@content-factory/contracts";

export const TRANSCRIPT_REPOSITORY = Symbol("TRANSCRIPT_REPOSITORY");

export type CreateTranscriptIntent = Readonly<{
  idempotencyKey: string;
  requestFingerprint: string;
  language: string;
  input: TranscriptInputCapture;
}>;

export interface TranscriptRepository {
  create(input: CreateTranscriptIntent): Promise<string>;
  detail(id: string): Promise<TranscriptEvidenceView | null>;
  complete(input: {
    id: string;
    artifact: TranscriptEvidenceView["artifact"];
  }): Promise<void>;
  fail(input: { id: string; code: string; message: string }): Promise<void>;
}

export class TranscriptIdempotencyConflictError extends Error {
  constructor() {
    super("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
  }
}
