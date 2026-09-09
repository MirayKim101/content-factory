import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AssemblyRenderPlan } from "../src/domain/media-job.js";
import {
  calculateCtaLayout,
  calculateOverlayBounds,
  FfmpegAssemblyRenderer,
  parseLoudnessReport,
} from "../src/infrastructure/ffmpeg-assembly-renderer.js";

describe("loudnorm report parsing", () => {
  it("classifies FFmpeg digital-silence measurements without accepting malformed finite reports", () => {
    const report = JSON.stringify({
      input_i: "-inf",
      input_tp: "-inf",
      input_lra: "0.00",
      input_thresh: "-70.00",
      output_i: "-inf",
      output_tp: "-inf",
      output_lra: "0.00",
      output_thresh: "-70.00",
      normalization_type: "dynamic",
      target_offset: "inf",
    });

    expect(parseLoudnessReport(report, "input")).toBeNull();
    expect(parseLoudnessReport(report, "output")).toBeNull();
    expect(() =>
      parseLoudnessReport(
        JSON.stringify({ input_i: "invalid", input_tp: "-inf" }),
        "input",
      ),
    ).toThrowError("ASSEMBLY_LOUDNESS_INVALID");
  });

  it("bounds extreme banner and two-line CTA layouts inside the output canvas", () => {
    expect(calculateOverlayBounds({ width: 320, height: 180 })).toEqual({
      width: 80,
      height: 45,
    });
    const cta = calculateCtaLayout("Ж".repeat(120), "BOTTOM_RIGHT", {
      width: 320,
      height: 180,
    });
    expect(cta.fontSize * 60 + 2 * cta.boxBorder + 24).toBeLessThanOrEqual(320);
    expect(
      cta.fontSize * 2 * 1.25 + 2 * cta.boxBorder + 14,
    ).toBeLessThanOrEqual(180);
    expect(() =>
      calculateCtaLayout("Ж".repeat(120), "TOP_LEFT", {
        width: 16,
        height: 16,
      }),
    ).toThrowError("ASSEMBLY_OVERLAY_BOUNDS_INVALID");
  });
});

describe.runIf(process.env.ASSEMBLY_RENDER_FFMPEG_TESTS === "1")(
  "real FFmpeg horizontal assembly",
  () => {
    let directory: string;
    let testFont: string;
    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
    const font =
      process.env.ASSEMBLY_FONT_PATH ||
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "cf-assembly-render-"));
      testFont = join(directory, "assembly-font.ttf");
      await copyFile(font, testFont);
      await writeFile(
        `${testFont}.sha256`,
        `${createHash("sha256")
          .update(await readFile(testFont))
          .digest("hex")}  ${testFont}\n`,
        { mode: 0o600 },
      );
    });
    afterAll(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("assembles intro, cut, advertisement, outro, banner and UTF-8 CTA into validated MP4", async () => {
      const cut = join(directory, "cut.mp4");
      const intro = join(directory, "intro.mp4");
      const advertisement = join(directory, "advertisement.mp4");
      const outro = join(directory, "outro.mp4");
      const banner = join(directory, "banner.png");
      await fixture(ffmpeg, cut, "testsrc2=size=320x180:rate=25", 4, true);
      await fixture(
        ffmpeg,
        intro,
        "color=c=blue:size=160x120:rate=25",
        1,
        false,
      );
      await fixture(
        ffmpeg,
        advertisement,
        "color=c=red:size=320x180:rate=25",
        1,
        true,
        880,
      );
      await fixture(
        ffmpeg,
        outro,
        "color=c=green:size=240x180:rate=25",
        1,
        false,
      );
      await command(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=yellow@0.8:size=100x1000",
        "-frames:v",
        "1",
        banner,
      ]);
      const identities = [cut, intro, advertisement, outro, banner].map(() =>
        randomUUID(),
      );
      const files = new Map(
        identities.map((id, index) => [
          id,
          [cut, intro, advertisement, outro, banner][index]!,
        ]),
      );
      const sizes = await Promise.all(
        [cut, intro, advertisement, outro, banner].map(async (path) =>
          BigInt((await stat(path)).size),
        ),
      );
      const plan: AssemblyRenderPlan = {
        intentId: randomUUID(),
        recipeRevisionId: randomUUID(),
        recipeRevision: 1,
        configurationFingerprint: "a".repeat(64),
        renderContractVersion: "horizontal-render-v1",
        audioProfileVersion: "youtube-stereo-v1",
        encodingProfileVersion: "youtube-h264-v1",
        expectedDurationMs: 7_000,
        advertisementInsertAtMs: 2_000,
        cta: {
          text: "Ж".repeat(120),
          startMs: 500,
          endMs: 3_500,
          position: "BOTTOM_RIGHT",
        },
        inputs: [
          input(identities[0]!, "CUT", 0, sizes[0]!, 4_000, true),
          input(identities[1]!, "INTRO", 0, sizes[1]!, 1_000, false),
          input(identities[2]!, "ADVERTISEMENT", 0, sizes[2]!, 1_000, true),
          input(identities[3]!, "OUTRO", 0, sizes[3]!, 1_000, false),
          {
            ...input(identities[4]!, "BANNER", 0, sizes[4]!, null, null),
            startMs: 1_000,
            endMs: 3_000,
            position: "TOP_LEFT",
          },
        ],
      };
      const output = join(directory, "result.mp4");
      const commandLog = join(directory, "ffmpeg-arguments.log");
      const wrapper = join(directory, "ffmpeg-wrapper");
      await writeFile(
        wrapper,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(commandLog)}\nexec ${shellQuote(ffmpeg)} "$@"\n`,
        { mode: 0o700 },
      );
      const renderer = new FfmpegAssemblyRenderer(wrapper, ffprobe, 1);
      await renderer.verifyCapabilities(testFont);
      const progress: Array<{ phase: string; ms: number }> = [];
      const encoded = await renderer.render({
        plan,
        files,
        scratchDirectory: directory,
        outputPath: output,
        fontPath: testFont,
        signal: AbortSignal.timeout(120_000),
        onProgress: (phase, ms) => progress.push({ phase, ms }),
      });
      const result = await renderer.inspectOutput({
        outputPath: output,
        expectedDurationMs: plan.expectedDurationMs,
        encoded,
        signal: AbortSignal.timeout(120_000),
      });
      expect(result).toMatchObject({
        durationMs: expect.closeTo(7_000, -2),
        width: 320,
        height: 180,
        fpsNumerator: 25,
        fpsDenominator: 1,
        videoCodec: "h264",
        pixelFormat: "yuv420p",
        audioCodec: "aac",
        audioSampleRate: 48_000,
        audioChannels: 2,
        normalizationProfileResult: "NORMALIZED",
      });
      expect((await stat(output)).size).toBeGreaterThan(0);
      expect(progress.some((value) => value.phase === "AUDIO_ANALYSIS")).toBe(
        true,
      );
      expect(progress.some((value) => value.phase === "ENCODE")).toBe(true);
      const boundedPasses = (await readFile(commandLog, "utf8"))
        .split("\n")
        .filter((line) => line.includes("-filter_complex_script"));
      expect(boundedPasses).toHaveLength(2);
      for (const invocation of boundedPasses) {
        expect(invocation).toContain("-filter_complex_threads 1");
        expect(invocation).toContain("-threads 1");
      }
      const [
        introPixel,
        cutBannerPixel,
        advertisementPixel,
        outroPixel,
        introBannerPosition,
        advertisementBannerPosition,
        outroBannerPosition,
      ] = await Promise.all([
        sampleRgb(ffmpeg, output, 0.5, 160, 90),
        sampleRgb(ffmpeg, output, 2.5, 13, 20),
        sampleRgb(ffmpeg, output, 3.5, 160, 90),
        sampleRgb(ffmpeg, output, 6.5, 160, 90),
        sampleRgb(ffmpeg, output, 0.5, 50, 20),
        sampleRgb(ffmpeg, output, 3.5, 50, 20),
        sampleRgb(ffmpeg, output, 6.5, 50, 20),
      ]);
      expect(introPixel[2]).toBeGreaterThan(introPixel[0]);
      expect(cutBannerPixel[0]).toBeGreaterThan(120);
      expect(cutBannerPixel[1]).toBeGreaterThan(120);
      expect(advertisementPixel[0]).toBeGreaterThan(advertisementPixel[1]);
      expect(outroPixel[1]).toBeGreaterThan(outroPixel[0]);
      expect(introBannerPosition[2]).toBeGreaterThan(introBannerPosition[0]);
      expect(advertisementBannerPosition[0]).toBeGreaterThan(
        advertisementBannerPosition[1],
      );
      expect(outroBannerPosition[1]).toBeGreaterThan(outroBannerPosition[0]);
      const [cutPreCrossings, advertisementCrossings, cutPostCrossings] =
        await Promise.all([
          sampleZeroCrossings(ffmpeg, output, 1.5),
          sampleZeroCrossings(ffmpeg, output, 3.5),
          sampleZeroCrossings(ffmpeg, output, 4.5),
        ]);
      expect(advertisementCrossings).toBeGreaterThan(cutPreCrossings * 1.6);
      expect(advertisementCrossings).toBeGreaterThan(cutPostCrossings * 1.6);
      expect(Math.abs(cutPreCrossings - cutPostCrossings)).toBeLessThan(30);
    }, 150_000);

    it("renders an existing but digitally silent audio stream as AAC stereo with nullable measurements", async () => {
      const cut = join(directory, "silent-cut.mp4");
      await fixture(ffmpeg, cut, "testsrc2=size=320x180:rate=25", 2, "silent");
      const id = randomUUID();
      const size = BigInt((await stat(cut)).size);
      const plan: AssemblyRenderPlan = {
        intentId: randomUUID(),
        recipeRevisionId: randomUUID(),
        recipeRevision: 1,
        configurationFingerprint: "c".repeat(64),
        renderContractVersion: "horizontal-render-v1",
        audioProfileVersion: "youtube-stereo-v1",
        encodingProfileVersion: "youtube-h264-v1",
        expectedDurationMs: 2_000,
        advertisementInsertAtMs: null,
        cta: null,
        inputs: [input(id, "CUT", 0, size, 2_000, true)],
      };
      const output = join(directory, "silent-result.mp4");
      const renderer = new FfmpegAssemblyRenderer(ffmpeg, ffprobe, 1);

      const encoded = await renderer.render({
        plan,
        files: new Map([[id, cut]]),
        scratchDirectory: directory,
        outputPath: output,
        fontPath: testFont,
        signal: AbortSignal.timeout(120_000),
        onProgress: () => undefined,
      });
      const result = await renderer.inspectOutput({
        outputPath: output,
        expectedDurationMs: plan.expectedDurationMs,
        encoded,
        signal: AbortSignal.timeout(120_000),
      });

      expect(result).toMatchObject({
        audioCodec: "aac",
        audioSampleRate: 48_000,
        audioChannels: 2,
        integratedLoudnessLufs: null,
        truePeakDbtp: null,
        normalizationProfileResult: "SILENT",
      });
      expect((await stat(output)).size).toBeGreaterThan(0);
    }, 150_000);
  },
);

function input(
  id: string,
  role: "CUT" | "INTRO" | "OUTRO" | "ADVERTISEMENT" | "BANNER",
  ordinal: number,
  sizeBytes: bigint,
  durationMs: number | null,
  hasAudio: boolean | null,
) {
  return {
    id,
    role,
    ordinal,
    objectKey: `private/${id}`,
    sizeBytes,
    sha256: "b".repeat(64),
    durationMs,
    hasAudio,
    startMs: null,
    endMs: null,
    position: null,
  } as const;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function fixture(
  ffmpeg: string,
  output: string,
  video: string,
  seconds: number,
  audio: boolean | "silent",
  frequency = 440,
): Promise<void> {
  await command(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    video,
    ...(audio
      ? [
          "-f",
          "lavfi",
          "-i",
          audio === "silent"
            ? "anullsrc=channel_layout=stereo:sample_rate=48000"
            : `sine=frequency=${frequency}:sample_rate=48000`,
        ]
      : []),
    "-t",
    String(seconds),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "1",
    ...(audio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    output,
  ]);
}

async function command(binary: string, args: string[]): Promise<void> {
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on(
    "data",
    (chunk: string) => (stderr = `${stderr}${chunk}`.slice(-16_384)),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`fixture ffmpeg failed (${code}): ${stderr}`);
}

async function sampleRgb(
  ffmpeg: string,
  input: string,
  atSeconds: number,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(atSeconds),
      "-i",
      input,
      "-vf",
      `crop=1:1:${x}:${y},format=rgb24`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on(
    "data",
    (chunk: string) => (stderr = `${stderr}${chunk}`.slice(-16_384)),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const bytes = Buffer.concat(chunks);
  if (code !== 0 || bytes.length < 3)
    throw new Error(`pixel sample failed: ${stderr}`);
  return [bytes[0]!, bytes[1]!, bytes[2]!];
}

async function sampleZeroCrossings(
  ffmpeg: string,
  input: string,
  atSeconds: number,
): Promise<number> {
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(atSeconds),
      "-t",
      "0.2",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "s16le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on(
    "data",
    (chunk: string) => (stderr = `${stderr}${chunk}`.slice(-16_384)),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`audio sample failed: ${stderr}`);
  const samples = Buffer.concat(chunks);
  if (samples.length < 4) throw new Error("audio sample was empty");
  let crossings = 0;
  let previous = samples.readInt16LE(0);
  for (let offset = 2; offset + 1 < samples.length; offset += 2) {
    const current = samples.readInt16LE(offset);
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) {
      crossings += 1;
    }
    previous = current;
  }
  return crossings;
}
