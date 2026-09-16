/** Runs only when explicitly invoked inside the pinned worker image. */
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FfmpegFrameExtractor,
  runFrameProcess,
} from "../../src/infrastructure/ffmpeg-frame-extractor.js";

const output = process.env.FRAME_FIXTURE_OUTPUT_ROOT;
if (!output?.startsWith("/tmp/content-factory-frame-adapter-"))
  throw new Error("Scoped fixture directory required");
await mkdir(output, { recursive: true });
const extractor = new FfmpegFrameExtractor(
  "/usr/bin/ffmpeg",
  "/usr/bin/ffprobe",
  "/usr/bin/timeout",
);
await extractor.verifyAvailable();
const fixtures = [
  {
    name: "cfr",
    size: "960x360",
    rate: 25,
    filter: null,
    extra: [],
    expected: [760_000, 1_520_000, 2_280_000],
    dimensions: [640, 240],
  },
  {
    name: "vfr",
    size: "320x240",
    rate: 30,
    filter: "select='not(mod(n,9))'",
    extra: ["-fps_mode", "vfr"],
    expected: [900_000, 1_500_000, 2_400_000],
    dimensions: [320, 240],
  },
  {
    name: "nonzero",
    size: "854x480",
    rate: 25,
    filter: "setpts=PTS+2/TB",
    extra: ["-copyts", "-avoid_negative_ts", "disabled"],
    expected: [760_000, 1_520_000, 2_280_000],
    dimensions: [640, 360],
  },
  {
    name: "anamorphic",
    size: "720x576",
    rate: 25,
    filter: "setsar=16/15",
    extra: [],
    expected: [760_000, 1_520_000, 2_280_000],
    dimensions: [640, 480],
  },
];
const evidence: unknown[] = [];
for (const fixture of fixtures) {
  const input = join(output, `${fixture.name}.mp4`);
  await runFrameProcess(
    "/usr/bin/timeout",
    "/usr/bin/ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${fixture.size}:rate=${fixture.rate}:duration=3`,
      ...(fixture.filter ? ["-vf", fixture.filter] : []),
      ...fixture.extra,
      "-an",
      "-c:v",
      "mpeg4",
      "-q:v",
      "2",
      input,
    ],
    new Date(Date.now() + 60_000),
    new AbortController().signal,
  );
  const directory = join(output, fixture.name);
  await mkdir(directory, { recursive: true });
  const frames = await extractor.extract({
    sourcePath: input,
    outputDirectory: directory,
    cutStartMs: 10_000,
    cutEndMs: 13_000,
    inputSizeBytes: (await stat(input)).size,
    workDeadlineAt: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    onMeasuredProgress: async () => {},
  });
  assert.deepEqual(
    frames.map((frame) => frame.measurement.actualPtsTicks),
    fixture.expected,
  );
  for (const frame of frames) {
    assert.deepEqual(
      [frame.measurement.width, frame.measurement.height],
      fixture.dimensions,
    );
    assert.equal(
      frame.measurement.mappedSourceMs,
      10_000 + frame.measurement.actualPtsTicks / 1000,
    );
  }
  evidence.push({
    fixture: fixture.name,
    frames: frames.map((frame) => frame.measurement),
  });
}
await writeFile(
  join(output, "adapter-evidence.json"),
  JSON.stringify(evidence, null, 2),
);
const tinyInput = join(output, "tiny-anamorphic.mp4");
await runFrameProcess(
  "/usr/bin/timeout",
  "/usr/bin/ffmpeg",
  [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=10x4:rate=25:duration=3",
    "-vf",
    "setsar=1/2",
    "-an",
    "-c:v",
    "mpeg4",
    "-q:v",
    "2",
    tinyInput,
  ],
  new Date(Date.now() + 60_000),
  new AbortController().signal,
);
const tinyOutput = join(output, "tiny-anamorphic");
await mkdir(tinyOutput, { recursive: true });
await assert.rejects(
  extractor.extract({
    sourcePath: tinyInput,
    outputDirectory: tinyOutput,
    cutStartMs: 0,
    cutEndMs: 3000,
    inputSizeBytes: (await stat(tinyInput)).size,
    workDeadlineAt: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    onMeasuredProgress: async () => {},
  }),
  (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === "FRAME_TIMING_UNSUPPORTED",
);
console.log(
  JSON.stringify({
    passed: fixtures.length,
    decodedJpegs: fixtures.length * 3,
    tinyAspectRejected: true,
    output,
  }),
);
