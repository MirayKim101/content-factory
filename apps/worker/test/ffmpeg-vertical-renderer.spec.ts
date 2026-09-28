import { describe, expect, it } from "vitest";

import {
  boundedDiagnosticTail,
  verticalRenderArguments,
} from "../src/infrastructure/ffmpeg-vertical-renderer.js";

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

  it("selects one video and audio stream and strips source metadata", () => {
    const args = verticalRenderArguments("source.mp4", "vertical.mp4");

    expect(args).toEqual(
      expect.arrayContaining([
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-sn",
        "-dn",
      ]),
    );
    expect(args.filter((argument) => argument === "-map")).toHaveLength(2);
    expect(args).toContain("0:v:0");
    expect(args).toContain("0:a:0");
  });
});
