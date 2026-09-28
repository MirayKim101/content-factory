import { describe, expect, it } from "vitest";

import { boundedDiagnosticTail } from "../src/infrastructure/ffmpeg-vertical-renderer.js";

describe("FfmpegVerticalRenderer diagnostics", () => {
  it("keeps a bounded cumulative stderr tail across many chunks", () => {
    let stderr = "";
    for (let index = 0; index < 100; index++)
      stderr = boundedDiagnosticTail(stderr, String(index).padStart(64, "x"));

    expect(stderr).toHaveLength(4_000);
    expect(stderr).toBe(stderr.slice(-4_000));
    expect(stderr).toContain("99");
    expect(stderr).not.toContain("00");
  });
});
