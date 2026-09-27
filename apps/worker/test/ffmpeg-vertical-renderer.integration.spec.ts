import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { workerConfig } from "../src/config.js";
import { FfmpegVerticalRenderer } from "../src/infrastructure/ffmpeg-vertical-renderer.js";

const execute = promisify(execFile);

describe.skipIf(process.env.RUN_VERTICAL_RENDER_INTEGRATION !== "1")(
  "FFmpeg vertical renderer integration",
  () => {
    it("renders a decodable 1080x1920 H.264/AAC asset", async () => {
      const config = workerConfig();
      const directory = await mkdtemp(join(tmpdir(), "vertical-render-e2e-"));
      const input = join(directory, "landscape.mp4");
      const output = join(directory, "portrait.mp4");
      try {
        await execute(config.ffmpegPath, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=1280x720:rate=24:duration=1",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=1",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          input,
        ]);
        const renderer = new FfmpegVerticalRenderer(
          config.ffmpegPath,
          config.ffprobePath,
        );
        const result = await renderer.render(
          input,
          output,
          new AbortController().signal,
        );
        expect(result).toMatchObject({
          width: 1080,
          height: 1920,
          videoCodec: "h264",
          audioCodec: "aac",
        });
        expect(result.durationMs).toBeGreaterThanOrEqual(900);
        expect(result.durationMs).toBeLessThanOrEqual(1_100);
        await expect(
          execute(config.ffmpegPath, [
            "-v",
            "error",
            "-i",
            output,
            "-f",
            "null",
            "-",
          ]),
        ).resolves.toBeDefined();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
