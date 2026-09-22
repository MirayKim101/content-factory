import { describe, expect, it } from "vitest";

import {
  validateTranscriptSegments,
  type TranscriptSegment,
} from "../src/transcript.js";

describe("transcript contract", () => {
  const segments: TranscriptSegment[] = [
    { ordinal: 0, startMs: 0, endMs: 1_000, text: "hello" },
    { ordinal: 1, startMs: 1_000, endMs: 2_500, text: "world" },
  ];

  it("accepts ordered bounded segments", () => {
    expect(() => validateTranscriptSegments(segments, 3_000)).not.toThrow();
  });

  it("rejects overlap, gaps in ordinal and empty text", () => {
    expect(() =>
      validateTranscriptSegments(
        [segments[0], { ...segments[1], startMs: 900 }],
        3_000,
      ),
    ).toThrow("TRANSCRIPT_SEGMENTS_INVALID");
    expect(() =>
      validateTranscriptSegments([{ ...segments[0], ordinal: 1 }], 3_000),
    ).toThrow("TRANSCRIPT_SEGMENTS_INVALID");
    expect(() =>
      validateTranscriptSegments([{ ...segments[0], text: "   " }], 3_000),
    ).toThrow("TRANSCRIPT_SEGMENTS_INVALID");
  });
});
