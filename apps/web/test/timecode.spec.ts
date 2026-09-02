import { describe, expect, it } from "vitest";

import {
  formatTimecode,
  parseTimecode,
  segmentFromBounds,
  validateSegments,
} from "../app/features/edit-cut-segments/model/segments";

describe("manual cut timecodes", () => {
  it("parses accepted values to exact integer milliseconds", () => {
    expect(parseTimecode("00:00:00.1")).toBe(100);
    expect(parseTimecode("12:04.250")).toBe(724_250);
    expect(parseTimecode("01:12:04.250")).toBe(4_324_250);
    expect(formatTimecode(4_324_250)).toBe("01:12:04.250");
  });

  it("rejects malformed and over-precise values", () => {
    expect(parseTimecode("-1:00")).toBeNull();
    expect(parseTimecode("00:00:00.0001")).toBeNull();
    expect(parseTimecode("00:72:00")).toBeNull();
    expect(parseTimecode("text")).toBeNull();
  });

  it("rejects invalid and duplicate bounds but permits overlaps", () => {
    const result = validateSegments(
      [
        { clientKey: "a", startText: "00:00:01", endText: "00:00:05" },
        { clientKey: "b", startText: "00:00:04", endText: "00:00:08" },
        { clientKey: "c", startText: "00:00:01", endText: "00:00:05" },
      ],
      10_000,
    );
    expect(result.segments).toHaveLength(2);
    expect(result.errors.c).toBe("Этот отрезок уже добавлен.");
  });

  it("clones failed bounds into a new independently identified draft", () => {
    const first = segmentFromBounds(1_250, 9_500);
    const second = segmentFromBounds(1_250, 9_500);
    expect(first).toMatchObject({
      startText: "00:00:01.250",
      endText: "00:00:09.500",
    });
    expect(first.clientKey).not.toBe(second.clientKey);
  });
});
