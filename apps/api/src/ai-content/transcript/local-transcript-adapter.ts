import { createHash } from "node:crypto";
import {
  LOCAL_TRANSCRIPT_ADAPTER_VERSION,
  TRANSCRIPT_CONTRACT_VERSION,
  validateTranscriptSegments,
  type TranscriptArtifact,
  type TranscriptSegment,
} from "@content-factory/contracts";

export type LocalTranscriptFixture = Readonly<{
  language: string;
  segments: readonly TranscriptSegment[];
}>;

const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENTS = 10_000;

export function normalizeLocalTranscriptFixture(
  fixture: LocalTranscriptFixture,
  durationMs: number,
): LocalTranscriptFixture {
  const serialized = JSON.stringify(fixture);
  if (Buffer.byteLength(serialized, "utf8") > MAX_FIXTURE_BYTES)
    throw new Error("TRANSCRIPT_FIXTURE_TOO_LARGE");
  if (!/^[a-zA-Z]{2,16}(?:-[a-zA-Z]{2,16})?$/.test(fixture.language))
    throw new Error("TRANSCRIPT_LANGUAGE_INVALID");
  if (!Array.isArray(fixture.segments) || fixture.segments.length > MAX_SEGMENTS)
    throw new Error("TRANSCRIPT_SEGMENTS_INVALID");
  const segments = fixture.segments.map((segment) => ({
    ordinal: segment.ordinal,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text.trim(),
  }));
  validateTranscriptSegments(segments, durationMs);
  return { language: fixture.language, segments };
}

/**
 * The first adapter intentionally consumes an operator supplied JSON fixture.
 * It has no network/provider dependency and produces the same immutable artifact
 * shape that a future ai-worker adapter must produce.
 */
export class LocalManualTranscriptAdapter {
  readonly version = LOCAL_TRANSCRIPT_ADAPTER_VERSION;

  transcribe(input: {
    fixture: LocalTranscriptFixture;
    durationMs: number;
    artifactId: string;
  }): TranscriptArtifact {
    const normalized = normalizeLocalTranscriptFixture(
      input.fixture,
      input.durationMs,
    );
    const segments = normalized.segments;
    const payload = JSON.stringify({
      contractVersion: TRANSCRIPT_CONTRACT_VERSION,
      adapterVersion: this.version,
      language: normalized.language,
      segments,
    });
    return {
      id: input.artifactId,
      contentType: "application/json",
      sizeBytes: Buffer.byteLength(payload, "utf8"),
      sha256: createHash("sha256").update(payload).digest("hex"),
      adapterVersion: this.version,
      language: normalized.language,
      segments,
    };
  }

  serialize(artifact: TranscriptArtifact): Buffer {
    return Buffer.from(
      JSON.stringify({
        contractVersion: TRANSCRIPT_CONTRACT_VERSION,
        adapterVersion: artifact.adapterVersion,
        language: artifact.language,
        segments: artifact.segments,
      }),
      "utf8",
    );
  }
}
