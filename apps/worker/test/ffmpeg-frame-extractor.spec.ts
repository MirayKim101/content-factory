import { describe, expect, it } from "vitest";
import {
  FRAME_EXTRACTOR_VERSION,
  FRAME_EXTRACTION_RECIPE,
  frameRequestedPositions,
  validateFrameMeasurements,
  type FrameMeasurement,
} from "@content-factory/contracts";
import {
  buildFrameArguments,
  parseFramePresentationDuration,
  parseSelectedFrameTiming,
  runFrameProcess,
  parseInputDisplayGeometry,
  validateJpegProbe,
} from "../src/infrastructure/ffmpeg-frame-extractor.js";

function record(ticks: number, n = 0): string {
  return `[Parsed_showinfo_5 @ 0xabc] n: ${n} pts: ${ticks} pts_time:${ticks / 1_000_000} pos: 44 fmt:yuvj420p sar:1/1 s:640x240 i:P iskey:1 type:I checksum:11\n`;
}
const config =
  "[Parsed_showinfo_5 @ 0xabc] config in time_base: 1/1000000, frame_rate: 25/1\n";

describe("frozen sparse frame extraction recipe", () => {
  it("uses normalized integer one-shot selection and fixes the complete output argv", () => {
    expect(
      buildFrameArguments({
        sourcePath: "/cut.mp4",
        outputPath: "/frame.jpg",
        requestedMs: 750,
      }),
    ).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-loglevel",
      "info",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/cut.mp4",
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-vf",
      "settb=AVTB,setpts=PTS-STARTPTS,select='gte(pts,750000)*isnan(prev_selected_t)',scale=w='min(2*floor(iw*sar/2),2*round(iw*sar*min(1,640/max(iw*sar,ih))/2))':h='min(2*floor(ih/2),2*round(ih*min(1,640/max(iw*sar,ih))/2))':flags=lanczos,setsar=1,showinfo",
      "-vsync",
      "0",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-q:v",
      "2",
      "-pix_fmt",
      "yuvj420p",
      "-threads",
      "1",
      "-f",
      "image2",
      "-update",
      "1",
      "/frame.jpg",
    ]);
  });

  it("distinguishes requested 750ms from measured 760ms, refusing extra or unproven timing", () => {
    expect(parseSelectedFrameTiming(config + record(760_000))).toEqual({
      actualPtsTicks: 760_000,
      width: 640,
      height: 240,
    });
    for (const log of [
      config,
      record(760_000),
      config + record(760_000) + record(800_000, 1),
      config.replace("1/1000000", "1/12800") + record(760_000),
      config + record(-1),
    ]) {
      expect(() => parseSelectedFrameTiming(log)).toThrowError(
        expect.objectContaining({ code: "FRAME_TIMING_UNSUPPORTED" }),
      );
    }
  });

  it("uses stream duration independent of nonzero origin; refuses format-only duration", () => {
    expect(
      parseFramePresentationDuration(
        JSON.stringify({
          streams: [
            { duration_ts: 38400, time_base: "1/12800", start_time: "2" },
          ],
          format: { duration: "5" },
        }),
      ),
    ).toBe(3_000_000);
    expect(() =>
      parseFramePresentationDuration('{"format":{"duration":"3"}}'),
    ).toThrow();
  });

  it("checks actual JPEG codec, square SAR, dimensions and anamorphic no-upscale", () => {
    const geometry = parseInputDisplayGeometry(
      '{"streams":[{"width":720,"height":576,"sample_aspect_ratio":"16:15"}]}',
    );
    expect(geometry).toEqual({ width: 768, height: 576 });
    const image = {
      codec_name: "mjpeg",
      width: 640,
      height: 480,
      sample_aspect_ratio: "1:1",
    };
    expect(() =>
      validateJpegProbe(
        JSON.stringify({ streams: [image] }),
        { width: 640, height: 480 },
        geometry,
      ),
    ).not.toThrow();
    for (const patch of [
      { codec_name: "png" },
      { width: 638 },
      { sample_aspect_ratio: "16:15" },
    ]) {
      expect(() =>
        validateJpegProbe(
          JSON.stringify({ streams: [{ ...image, ...patch }] }),
          { width: 640, height: 480 },
          geometry,
        ),
      ).toThrow();
    }
    expect(() =>
      parseInputDisplayGeometry(
        '{"streams":[{"width":1,"height":1,"sample_aspect_ratio":"1:1"}]}',
      ),
    ).toThrow();
    expect(() =>
      validateJpegProbe(
        '{"streams":[{"codec_name":"mjpeg","width":4,"height":4,"sample_aspect_ratio":"1:1"}]}',
        { width: 4, height: 4 },
        { width: 5, height: 4 },
      ),
    ).toThrow();
  });

  it("enforces immutable admission ceilings and distinct quartile positions", () => {
    expect(frameRequestedPositions(1000, 4000, 100)).toEqual([750, 1500, 2250]);
    for (const args of [
      [0, 2, 1],
      [0, 600001, 1],
      [0, 3000, 536870913],
      [1.2, 3000, 1],
    ]) {
      expect(() =>
        frameRequestedPositions(args[0]!, args[1]!, args[2]!),
      ).toThrow("FRAME_INPUT_UNSUPPORTED");
    }
  });

  it("refuses duplicate decoded frames even when every requested offset is different", () => {
    const frames: FrameMeasurement[] = [750, 1500, 2250].map(
      (requested, ordinal) => ({
        ordinal,
        requestedCutMs: requested,
        requestedSourceMs: 1000 + requested,
        actualPtsTicks: requested * 1000,
        timeBaseNumerator: 1,
        timeBaseDenominator: 1_000_000,
        actualCutMs: requested,
        mappedSourceMs: 1000 + requested,
        width: 640,
        height: 240,
        sizeBytes: 100,
        sha256: "a".repeat(64),
        contentType: "image/jpeg",
        recipeVersion: FRAME_EXTRACTION_RECIPE,
        extractorVersion: FRAME_EXTRACTOR_VERSION,
        ffmpegVersion: "ffmpeg version 5.1.9",
      }),
    );
    expect(() =>
      validateFrameMeasurements(frames, [750, 1500, 2250], 1000, 3_000_000),
    ).not.toThrow();
    frames[0]!.actualPtsTicks = 1_500_000;
    frames[0]!.actualCutMs = 1500;
    frames[0]!.mappedSourceMs = 2500;
    expect(() =>
      validateFrameMeasurements(frames, [750, 1500, 2250], 1000, 3_000_000),
    ).toThrow("FRAME_TIMING_UNSUPPORTED");
  });
});

describe("independent bounded process watchdog", () => {
  it("fails closed for missing watchdog and expired absolute deadline", async () => {
    await expect(
      runFrameProcess(
        "/nonexistent-cf-watchdog",
        "true",
        [],
        new Date(Date.now() + 5000),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "FRAME_WATCHDOG_UNAVAILABLE",
      retryable: false,
    });
    await expect(
      runFrameProcess(
        "timeout",
        "true",
        [],
        new Date(0),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "FRAME_WORK_DEADLINE_EXCEEDED",
      retryable: false,
    });
  });

  it("enforces remaining deadline outside the JS event loop and reports terminal timeout", async () => {
    const started = Date.now();
    await expect(
      runFrameProcess(
        "timeout",
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        new Date(started + 150),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "FRAME_WORK_DEADLINE_EXCEEDED",
      retryable: false,
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("aborts and waits for the owned process before rejecting", async () => {
    const controller = new AbortController();
    const pending = runFrameProcess(
      "timeout",
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      new Date(Date.now() + 5000),
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("lease lost")), 50);
    await expect(pending).rejects.toThrow("lease lost");
  });

  it("preserves lease-loss abort after killing a TERM-ignoring child", async () => {
    const controller = new AbortController();
    const pending = runFrameProcess(
      "timeout",
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      new Date(Date.now() + 30_000),
      controller.signal,
    );
    setTimeout(
      () => controller.abort(new Error("lease lost while stubborn")),
      150,
    );
    await expect(pending).rejects.toThrow("lease lost while stubborn");
  }, 15_000);

  it("diagnostic overflow is a bounded terminal error, not a work timeout", async () => {
    await expect(
      runFrameProcess(
        "timeout",
        process.execPath,
        [
          "-e",
          "process.stderr.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)",
        ],
        new Date(Date.now() + 30_000),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "FRAME_PROCESS_OUTPUT_LIMIT",
      retryable: false,
    });
  });

  it("does not relabel an early process exit 137 as a deadline", async () => {
    await expect(
      runFrameProcess(
        "timeout",
        process.execPath,
        ["-e", "process.exit(137)"],
        new Date(Date.now() + 30_000),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "FRAME_TIMING_UNSUPPORTED",
      retryable: false,
    });
  });
});
