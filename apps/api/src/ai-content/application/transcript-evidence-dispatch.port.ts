export const TRANSCRIPT_EVIDENCE_DISPATCH = Symbol(
  "TRANSCRIPT_EVIDENCE_DISPATCH",
);

export const TRANSCRIPT_JOB_SCHEMA_VERSION = "transcript-job-v1" as const;

export interface TranscriptEvidenceDeliveryV1 {
  schemaVersion: typeof TRANSCRIPT_JOB_SCHEMA_VERSION;
  intentId: string;
}

/** Disposable delivery boundary. PostgreSQL remains the authoritative state. */
export interface TranscriptEvidenceDispatch {
  dispatch(delivery: TranscriptEvidenceDeliveryV1): Promise<void>;
}
