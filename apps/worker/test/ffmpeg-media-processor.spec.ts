import { describe, expect, it } from "vitest";

import {
  buildCutArguments,
  parseOutputProbe,
} from "../src/infrastructure/ffmpeg-media-processor.js";

describe("post-encode FFprobe parsing", () => {
  it("requires structured MP4 probe data and exposes duration/video FPS", () => {
    expect(
      parseOutputProbe(
        JSON.stringify({
          format: { duration: "1.004" },
          streams: [
            { codec_type: "audio" },
            { codec_type: "video", avg_frame_rate: "30000/1001" },
          ],
        }),
        "ffprobe version integration\nmore",
      ),
    ).toEqual({
      durationMs: 1_004,
      hasVideo: true,
      frameRate: 30_000 / 1_001,
      version: "ffprobe version integration",
    });
  });

  it("rejects arbitrary text instead of treating it as an MP4 result", () => {
    expect(() => parseOutputProbe("result", "ffprobe test")).toThrowError(
      expect.objectContaining({ code: "CUT_OUTPUT_INVALID", retryable: false }),
    );
  });
});

describe("versioned FFmpeg cut recipes", () => {
  const common = {
    sourcePath: "/cache/source.mp4",
    outputPath: "/scratch/result.mp4",
    startMs: 766_000,
    endMs: 801_000,
  };

  it.each([
    ["stage1-cut-h264-v1", "medium"],
    ["stage1-cut-h264-v2", "veryfast"],
  ])("maps %s to its exact reproducible arguments", (recipeVersion, preset) => {
    expect(buildCutArguments({ ...common, recipeVersion })).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-ss",
      "766.000",
      "-i",
      "/cache/source.mp4",
      "-t",
      "35.000",
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "-nostats",
      "/scratch/result.mp4",
    ]);
  });

  it("rejects an unknown recipe without a fallback", () => {
    expect(() =>
      buildCutArguments({ ...common, recipeVersion: "stage1-cut-h264-v999" }),
    ).toThrowError(
      expect.objectContaining({
        code: "CUT_RECIPE_UNSUPPORTED",
        retryable: false,
      }),
    );
  });
});
