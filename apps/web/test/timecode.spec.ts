import { describe, expect, it } from "vitest";

import {
  formatTimecode,
  parseTimecode,
} from "../app/features/manual-cut/model/timecode";
import { CutIntentKeys } from "../app/features/manual-cut/model/use-manual-cut";

describe("manual cut timecodes", () => {
  it("round-trips exact integer milliseconds", () => {
    expect(parseTimecode("01:02:03.004")).toBe(3_723_004);
    expect(formatTimecode(3_723_004)).toBe("01:02:03.004");
    expect(parseTimecode("5.25")).toBe(5_250);
  });

  it.each(["", "00:60:00", "00:00:01.0000", "-1", "2147483.648"])(
    "rejects %s",
    (value) => expect(parseTimecode(value)).toBeNull(),
  );
});

describe("cut request idempotency", () => {
  it("reuses the key after an unknown response and rotates after success or an edit", () => {
    let next = 0;
    const keys = new CutIntentKeys(() => `key-${++next}`);
    expect(keys.forRange(1_000, 2_000)).toBe("key-1");
    expect(keys.forRange(1_000, 2_000)).toBe("key-1");
    expect(keys.forRange(1_000, 2_001)).toBe("key-2");
    keys.clear();
    expect(keys.forRange(1_000, 2_001)).toBe("key-3");
  });
});
