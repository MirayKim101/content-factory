import { describe, expect, it } from "vitest";

import { parseOutputProbe } from "../src/infrastructure/ffmpeg-media-processor.js";

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
