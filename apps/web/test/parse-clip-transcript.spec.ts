import { describe, expect, it } from "vitest";

import {
  ClipTranscriptFormatError,
  parseClipTranscript,
} from "../app/features/clip-generation/model/parse-transcript";

describe("parseClipTranscript", () => {
  it("parses ordered SRT and VTT cues into the API contract", () => {
    expect(
      parseClipTranscript(
        `1\n00:00:01,000 --> 00:00:04,500\nПервый момент\n\ncue-two\n00:05.000 --> 00:09.000\nВторой <b>момент</b>`,
        10_000,
      ),
    ).toEqual([
      { startMs: 1_000, endMs: 4_500, text: "Первый момент" },
      { startMs: 5_000, endMs: 9_000, text: "Второй момент" },
    ]);
  });

  it("parses a standard WebVTT header with minute timestamps", () => {
    expect(
      parseClipTranscript(
        `WEBVTT\n\n00:01.000 --> 00:04.500\nПервый момент`,
        10_000,
      ),
    ).toEqual([{ startMs: 1_000, endMs: 4_500, text: "Первый момент" }]);
  });

  it("rejects a damaged block instead of silently dropping it", () => {
    expect(() =>
      parseClipTranscript(
        `00:00:01,000 --> 00:00:04,000\nОдин\n\n00:05.000 -> 00:09.000\nПовреждено`,
        10_000,
      ),
    ).toThrow("повреждённый блок");
  });

  it("rejects adjacent cues without the required blank separator", () => {
    expect(() =>
      parseClipTranscript(
        `00:00:01,000 --> 00:00:04,000\nОдин\n00:00:05,000 --> 00:00:09,000\nДва`,
        10_000,
      ),
    ).toThrow("пустая строка");
  });

  it("rejects overlaps and cues outside the exact source duration", () => {
    expect(() =>
      parseClipTranscript(
        `00:00:01,000 --> 00:00:06,000\nОдин\n\n00:00:05,000 --> 00:00:11,000\nДва`,
        10_000,
      ),
    ).toThrow(ClipTranscriptFormatError);
  });
});
