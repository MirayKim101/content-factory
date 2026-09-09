import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AssemblyEncodedOutput,
  AssemblyRenderer,
} from "../application/ports.js";
import type {
  AssemblyRenderInput,
  AssemblyRenderPlan,
} from "../domain/media-job.js";
import { ControlledMediaError } from "../domain/media-job.js";

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeResult {
  format?: { duration?: string };
  streams?: ProbeStream[];
}

interface InputDescriptor {
  input: AssemblyRenderInput;
  path: string;
  index: number;
  audioIndex: number;
  hasAudio: boolean;
  durationMs: number;
}

export class FfmpegAssemblyRenderer implements AssemblyRenderer {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
    private readonly threads: number,
  ) {
    if (!Number.isSafeInteger(threads) || threads < 1 || threads > 32) {
      throw new Error("ASSEMBLY_THREAD_LIMIT_INVALID");
    }
  }

  async verifyCapabilities(fontPath: string): Promise<void> {
    const [font, manifest] = await Promise.all([
      readFile(fontPath),
      readFile(`${fontPath}.sha256`, "utf8"),
    ]);
    const expected = manifest.trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(font).digest("hex");
    if (!expected || expected !== actual) {
      throw new Error("ASSEMBLY_FONT_CHECKSUM_INVALID");
    }
    const filters = await runProcess(
      this.ffmpegPath,
      ["-hide_banner", "-filters"],
      AbortSignal.timeout(30_000),
    );
    for (const required of [
      "scale",
      "pad",
      "overlay",
      "drawtext",
      "loudnorm",
      "concat",
    ]) {
      if (!new RegExp(`\\b${required}\\b`).test(filters.stdout)) {
        throw new Error(
          `ASSEMBLY_FILTER_${required.toUpperCase()}_UNAVAILABLE`,
        );
      }
    }
  }

  async render(input: Parameters<AssemblyRenderer["render"]>[0]) {
    if (
      input.plan.renderContractVersion !== "horizontal-render-v1" ||
      input.plan.audioProfileVersion !== "youtube-stereo-v1" ||
      input.plan.encodingProfileVersion !== "youtube-h264-v1"
    ) {
      throw terminal(
        "ASSEMBLY_PROFILE_UNSUPPORTED",
        "The assembly profile is not supported.",
      );
    }
    const descriptors = await this.describeInputs(
      input.plan,
      input.files,
      input.signal,
    );
    const cut = descriptors.find((value) => value.input.role === "CUT");
    if (!cut)
      throw terminal("ASSEMBLY_CUT_MISSING", "The exact cut input is missing.");
    const cutProbe = await this.probe(cut.path, input.signal);
    const cutVideo = cutProbe.streams?.find(
      (stream) => stream.codec_type === "video",
    );
    if (!cutVideo?.width || !cutVideo.height) {
      throw terminal("ASSEMBLY_CUT_INVALID", "The exact cut video is invalid.");
    }
    const frameRate = rationalRate(
      cutVideo.avg_frame_rate ?? cutVideo.r_frame_rate,
    );
    if (!frameRate)
      throw terminal("ASSEMBLY_FPS_INVALID", "The cut frame rate is invalid.");
    const canvas = {
      width: cutVideo.width,
      height: cutVideo.height,
      ...frameRate,
    };

    const commonArgs = this.inputArguments(descriptors);
    const hasProgramAudio = descriptors.some((value) => value.hasAudio);
    let measured: LoudnessMeasurement | null = null;
    if (hasProgramAudio) {
      const analysisGraph = buildFilterGraph(
        input.plan,
        descriptors,
        canvas,
        input.fontPath,
        null,
        true,
      );
      const analysisPath = join(
        input.scratchDirectory,
        "audio-analysis.ffscript",
      );
      await writeFile(analysisPath, analysisGraph, { mode: 0o600 });
      const analysis = await runFfmpeg(
        this.ffmpegPath,
        [
          "-hide_banner",
          "-nostdin",
          "-y",
          ...commonArgs,
          ...assemblyComplexThreadArguments(this.threads),
          "-filter_complex_script",
          analysisPath,
          "-map",
          "[aout]",
          "-f",
          "null",
          "-",
          "-progress",
          "pipe:1",
          "-nostats",
        ],
        input.signal,
        (value) => input.onProgress("AUDIO_ANALYSIS", value),
      );
      measured = parseLoudnessReport(analysis.stderr, "input");
    }

    const ctaPath = join(input.scratchDirectory, "cta.txt");
    if (input.plan.cta) {
      await writeFile(ctaPath, wrapCta(input.plan.cta.text), { mode: 0o600 });
    }
    const finalGraph = buildFilterGraph(
      input.plan,
      descriptors,
      canvas,
      input.fontPath,
      measured,
      false,
      ctaPath,
    );
    const finalGraphPath = join(input.scratchDirectory, "assembly.ffscript");
    await writeFile(finalGraphPath, finalGraph, { mode: 0o600 });
    const encoded = await runFfmpeg(
      this.ffmpegPath,
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        ...commonArgs,
        ...assemblyComplexThreadArguments(this.threads),
        "-filter_complex_script",
        finalGraphPath,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        ...assemblyCodecThreadArguments(this.threads),
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        "-metadata",
        "creation_time=",
        "-progress",
        "pipe:1",
        "-nostats",
        input.outputPath,
      ],
      input.signal,
      (value) => input.onProgress("ENCODE", value),
    );
    const outputLoudness = measured
      ? parseLoudnessReport(encoded.stderr, "output")
      : null;
    return {
      canvas: {
        width: canvas.width,
        height: canvas.height,
        fpsNumerator: canvas.numerator,
        fpsDenominator: canvas.denominator,
      },
      outputLoudness: outputLoudness
        ? {
            integratedLoudnessLufs: outputLoudness.outputIntegrated!,
            truePeakDbtp: outputLoudness.outputTruePeak!,
          }
        : null,
    } satisfies AssemblyEncodedOutput;
  }

  async inspectOutput(input: Parameters<AssemblyRenderer["inspectOutput"]>[0]) {
    const output = await this.probe(input.outputPath, input.signal);
    const version = await Promise.all([
      runProcess(this.ffmpegPath, ["-version"], input.signal),
      runProcess(this.ffprobePath, ["-version"], input.signal),
    ]);
    return validateOutput(
      output,
      input.expectedDurationMs,
      {
        width: input.encoded.canvas.width,
        height: input.encoded.canvas.height,
        numerator: input.encoded.canvas.fpsNumerator,
        denominator: input.encoded.canvas.fpsDenominator,
      },
      input.encoded.outputLoudness,
      firstLine(version[0].stdout, "ffmpeg-unknown"),
      firstLine(version[1].stdout, "ffprobe-unknown"),
    );
  }

  private async describeInputs(
    plan: AssemblyRenderPlan,
    files: Map<string, string>,
    signal: AbortSignal,
  ): Promise<InputDescriptor[]> {
    const values: InputDescriptor[] = [];
    let nextIndex = 0;
    for (const item of plan.inputs) {
      const path = files.get(item.id);
      if (!path)
        throw terminal("ASSEMBLY_INPUT_MISSING", "A render input is missing.");
      if (item.role === "BANNER") {
        values.push({
          input: item,
          path,
          index: nextIndex++,
          audioIndex: -1,
          hasAudio: false,
          durationMs: 0,
        });
        continue;
      }
      const probe = await this.probe(path, signal);
      const durationMs = Math.round(Number(probe.format?.duration) * 1_000);
      const hasAudio = Boolean(
        probe.streams?.some((stream) => stream.codec_type === "audio"),
      );
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw terminal(
          "ASSEMBLY_INPUT_INVALID",
          "A render input has invalid duration.",
        );
      }
      const index = nextIndex++;
      const audioIndex = hasAudio ? index : nextIndex++;
      values.push({
        input: item,
        path,
        index,
        audioIndex,
        hasAudio,
        durationMs,
      });
    }
    return values;
  }

  private inputArguments(values: InputDescriptor[]): string[] {
    const args: string[] = [];
    for (const value of values) {
      if (value.input.role === "BANNER") {
        args.push(
          ...assemblyCodecThreadArguments(this.threads),
          "-loop",
          "1",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          value.path,
        );
        continue;
      }
      args.push(
        ...assemblyCodecThreadArguments(this.threads),
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        value.path,
      );
      if (!value.hasAudio) {
        args.push(
          ...assemblyCodecThreadArguments(this.threads),
          "-f",
          "lavfi",
          "-t",
          seconds(value.durationMs),
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
        );
      }
    }
    return args;
  }

  private async probe(path: string, signal: AbortSignal): Promise<ProbeResult> {
    const value = await runProcess(
      this.ffprobePath,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        path,
      ],
      signal,
    );
    try {
      return JSON.parse(value.stdout) as ProbeResult;
    } catch {
      throw terminal(
        "ASSEMBLY_PROBE_INVALID",
        "A render input could not be inspected.",
      );
    }
  }
}

export function assemblyComplexThreadArguments(threads: number): string[] {
  return ["-filter_complex_threads", String(threads)];
}

export function assemblyCodecThreadArguments(threads: number): string[] {
  return ["-threads", String(threads)];
}

function buildFilterGraph(
  plan: AssemblyRenderPlan,
  inputs: InputDescriptor[],
  canvas: {
    width: number;
    height: number;
    numerator: number;
    denominator: number;
  },
  fontPath: string,
  measured: LoudnessMeasurement | null,
  analysisOnly: boolean,
  ctaPath?: string,
): string {
  const videos = inputs.filter((value) => value.input.role !== "BANNER");
  const lines: string[] = [];
  for (const value of videos) {
    if (!analysisOnly) {
      lines.push(
        `[${value.index}:v:0]setpts=PTS-STARTPTS,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:black,fps=${canvas.numerator}/${canvas.denominator},setsar=1[v${value.index}]`,
      );
    }
    lines.push(
      `[${value.audioIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${seconds(value.durationMs)},asetpts=PTS-STARTPTS[a${value.index}]`,
    );
  }
  const orderedAudioLabels = canonicalAudioTimeline(plan, inputs, lines);
  if (!analysisOnly) {
    let cutLabel = `v${inputs.find((value) => value.input.role === "CUT")!.index}`;
    for (const banner of inputs.filter(
      (value) => value.input.role === "BANNER",
    )) {
      const bounds = calculateOverlayBounds(canvas);
      lines.push(
        `[${banner.index}:v:0]scale=${bounds.width}:${bounds.height}:force_original_aspect_ratio=decrease,format=rgba[b${banner.index}]`,
      );
      const next = `cut-overlay-${banner.index}`;
      const position = overlayPosition(banner.input.position!, canvas);
      lines.push(
        `[${cutLabel}][b${banner.index}]overlay=${position.x}:${position.y}:shortest=1:enable='gte(t,${seconds(banner.input.startMs!)})*lt(t,${seconds(banner.input.endMs!)})'[${next}]`,
      );
      cutLabel = next;
    }
    if (plan.cta && ctaPath) {
      const next = "cut-cta";
      const layout = calculateCtaLayout(
        plan.cta.text,
        plan.cta.position,
        canvas,
      );
      lines.push(
        `[${cutLabel}]drawtext=fontfile='${escapeFilterPath(fontPath)}':textfile='${escapeFilterPath(ctaPath)}':expansion=none:fontcolor=white:fontsize=${layout.fontSize}:box=1:boxcolor=black@0.65:boxborderw=${layout.boxBorder}:x=${layout.x}:y=${layout.y}:enable='gte(t,${seconds(plan.cta.startMs)})*lt(t,${seconds(plan.cta.endMs)})'[${next}]`,
      );
      cutLabel = next;
    }
    const ad = inputs.find((value) => value.input.role === "ADVERTISEMENT");
    const orderedVideoLabels: string[] = [];
    const intro = inputs.find((value) => value.input.role === "INTRO");
    const outro = inputs.find((value) => value.input.role === "OUTRO");
    if (intro) {
      orderedVideoLabels.push(`v${intro.index}`);
    }
    if (ad && plan.advertisementInsertAtMs !== null) {
      const split = seconds(plan.advertisementInsertAtMs);
      lines.push(`[${cutLabel}]split=2[cut-pre-source][cut-post-source]`);
      lines.push(
        `[cut-pre-source]trim=start=0:end=${split},setpts=PTS-STARTPTS[cut-pre]`,
      );
      lines.push(
        `[cut-post-source]trim=start=${split},setpts=PTS-STARTPTS[cut-post]`,
      );
      orderedVideoLabels.push("cut-pre", `v${ad.index}`, "cut-post");
    } else {
      orderedVideoLabels.push(cutLabel);
    }
    if (outro) {
      orderedVideoLabels.push(`v${outro.index}`);
    }
    lines.push(
      orderedVideoLabels.map((label) => `[${label}]`).join("") +
        `concat=n=${orderedVideoLabels.length}:v=1:a=0[vout]`,
    );
    lines.push(
      orderedAudioLabels.map((label) => `[${label}]`).join("") +
        `concat=n=${orderedAudioLabels.length}:v=0:a=1[programa]`,
    );
  } else {
    lines.push(
      orderedAudioLabels.map((label) => `[${label}]`).join("") +
        `concat=n=${orderedAudioLabels.length}:v=0:a=1[programa]`,
    );
  }
  const loudnorm = measured
    ? `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${measured.integrated}:measured_TP=${measured.truePeak}:measured_LRA=${measured.range}:measured_thresh=${measured.threshold}:offset=${measured.offset}:linear=true:print_format=json`
    : analysisOnly
      ? "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json"
      : "anull";
  lines.push(`[programa]${loudnorm}[aout]`);
  return `${lines.join(";\n")}\n`;
}

function canonicalAudioTimeline(
  plan: AssemblyRenderPlan,
  inputs: InputDescriptor[],
  lines: string[],
): string[] {
  const cut = inputs.find((value) => value.input.role === "CUT")!;
  const intro = inputs.find((value) => value.input.role === "INTRO");
  const outro = inputs.find((value) => value.input.role === "OUTRO");
  const ad = inputs.find((value) => value.input.role === "ADVERTISEMENT");
  const values: string[] = [];
  if (intro) values.push(`a${intro.index}`);
  if (ad && plan.advertisementInsertAtMs !== null) {
    const split = seconds(plan.advertisementInsertAtMs);
    lines.push(`[a${cut.index}]asplit=2[cut-a-pre-source][cut-a-post-source]`);
    lines.push(
      `[cut-a-pre-source]atrim=start=0:end=${split},asetpts=PTS-STARTPTS[cut-a-pre]`,
    );
    lines.push(
      `[cut-a-post-source]atrim=start=${split},asetpts=PTS-STARTPTS[cut-a-post]`,
    );
    values.push("cut-a-pre", `a${ad.index}`, "cut-a-post");
  } else values.push(`a${cut.index}`);
  if (outro) values.push(`a${outro.index}`);
  return values;
}

export function calculateOverlayBounds(canvas: {
  width: number;
  height: number;
}) {
  const marginX = Math.max(0, Math.min(32, Math.floor(canvas.width * 0.04)));
  const marginY = Math.max(0, Math.min(32, Math.floor(canvas.height * 0.04)));
  return {
    width: Math.max(
      1,
      Math.min(canvas.width - 2 * marginX, Math.floor(canvas.width * 0.25)),
    ),
    height: Math.max(
      1,
      Math.min(canvas.height - 2 * marginY, Math.floor(canvas.height * 0.25)),
    ),
  };
}

export interface LoudnessMeasurement {
  integrated: number;
  truePeak: number;
  range: number;
  threshold: number;
  offset: number;
  outputIntegrated?: number;
  outputTruePeak?: number;
}

export function parseLoudnessReport(
  stderr: string,
  mode: "input" | "output",
): LoudnessMeasurement | null {
  const blocks = [...stderr.matchAll(/\{[\s\S]*?\}/g)];
  for (const block of blocks.reverse()) {
    try {
      const value = JSON.parse(block[0]) as Record<string, unknown>;
      const measurement = {
        integrated: Number(value.input_i),
        truePeak: Number(value.input_tp),
        range: Number(value.input_lra),
        threshold: Number(value.input_thresh),
        offset: Number(value.target_offset),
        outputIntegrated: Number(value.output_i),
        outputTruePeak: Number(value.output_tp),
      };
      const required =
        mode === "input"
          ? [
              measurement.integrated,
              measurement.truePeak,
              measurement.range,
              measurement.threshold,
              measurement.offset,
            ]
          : [measurement.outputIntegrated, measurement.outputTruePeak];
      if (required.every(Number.isFinite)) return measurement;
      const silentFields =
        mode === "input"
          ? [value.input_i, value.input_tp]
          : [value.output_i, value.output_tp];
      if (silentFields.every(isNegativeInfinity)) return null;
    } catch {
      // Try the previous bounded JSON block.
    }
  }
  throw terminal(
    "ASSEMBLY_LOUDNESS_INVALID",
    "Audio normalization analysis was invalid.",
  );
}

function isNegativeInfinity(value: unknown): boolean {
  return (
    (typeof value === "string" && value.trim().toLowerCase() === "-inf") ||
    value === Number.NEGATIVE_INFINITY
  );
}

function validateOutput(
  probe: ProbeResult,
  expectedDurationMs: number,
  canvas: {
    width: number;
    height: number;
    numerator: number;
    denominator: number;
  },
  loudness: {
    integratedLoudnessLufs: number;
    truePeakDbtp: number;
  } | null,
  ffmpegVersion: string,
  ffprobeVersion: string,
) {
  const durationMs = Math.round(Number(probe.format?.duration) * 1_000);
  const videos =
    probe.streams?.filter((value) => value.codec_type === "video") ?? [];
  const audios =
    probe.streams?.filter((value) => value.codec_type === "audio") ?? [];
  const video = videos[0];
  const audio = audios[0];
  const outputRate = rationalRate(video?.avg_frame_rate ?? video?.r_frame_rate);
  const hasExpectedRate = Boolean(
    outputRate &&
    outputRate.numerator * canvas.denominator ===
      canvas.numerator * outputRate.denominator,
  );
  const hasExpectedSar =
    video?.sample_aspect_ratio === "1:1" ||
    video?.sample_aspect_ratio === "1/1";
  const toleranceMs = Math.max(
    250,
    Math.ceil((2 * 1_000 * canvas.denominator) / canvas.numerator),
  );
  const rotated = Boolean(
    (video?.tags?.rotate && video.tags.rotate !== "0") ||
    video?.side_data_list?.some(
      (value) => value.rotation && value.rotation !== 0,
    ),
  );
  if (
    !Number.isFinite(durationMs) ||
    Math.abs(durationMs - expectedDurationMs) > toleranceMs ||
    videos.length !== 1 ||
    audios.length !== 1 ||
    video?.codec_name !== "h264" ||
    video.pix_fmt !== "yuv420p" ||
    video.width !== canvas.width ||
    video.height !== canvas.height ||
    !hasExpectedRate ||
    !hasExpectedSar ||
    rotated ||
    audio?.codec_name !== "aac" ||
    Number(audio.sample_rate) !== 48_000 ||
    audio.channels !== 2
  ) {
    throw terminal(
      "ASSEMBLY_OUTPUT_INVALID",
      "The assembled MP4 failed output validation.",
    );
  }
  if (
    loudness !== null &&
    (Math.abs(loudness.integratedLoudnessLufs + 14) > 1 ||
      loudness.truePeakDbtp > -1)
  ) {
    throw terminal(
      "ASSEMBLY_LOUDNESS_OUT_OF_RANGE",
      "The assembled audio failed normalization validation.",
    );
  }
  return {
    durationMs,
    width: video.width,
    height: video.height,
    fpsNumerator: canvas.numerator,
    fpsDenominator: canvas.denominator,
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48_000,
    audioChannels: 2,
    ffmpegVersion,
    ffprobeVersion,
    integratedLoudnessLufs: loudness?.integratedLoudnessLufs ?? null,
    truePeakDbtp: loudness?.truePeakDbtp ?? null,
    normalizationProfileResult: loudness ? "NORMALIZED" : "SILENT",
  };
}

function rationalRate(value: string | undefined) {
  if (!value) return null;
  const parts = value.split("/");
  const n = Number(parts[0]);
  const d = Number(parts[1] ?? "1");
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(d) ||
    n <= 0 ||
    d <= 0 ||
    n / d > 120
  )
    return null;
  return { numerator: n, denominator: d };
}

function overlayPosition(
  position: NonNullable<AssemblyRenderInput["position"]>,
  canvas: { width: number; height: number },
) {
  const marginX = Math.max(0, Math.min(32, Math.floor(canvas.width * 0.04)));
  const marginY = Math.max(0, Math.min(32, Math.floor(canvas.height * 0.04)));
  return {
    x: position.endsWith("RIGHT") ? `W-w-${marginX}` : String(marginX),
    y: position.startsWith("BOTTOM") ? `H-h-${marginY}` : String(marginY),
  };
}

export function calculateCtaLayout(
  text: string,
  position: NonNullable<AssemblyRenderInput["position"]>,
  canvas: { width: number; height: number },
) {
  const marginX = Math.max(0, Math.min(32, Math.floor(canvas.width * 0.04)));
  const marginY = Math.max(0, Math.min(32, Math.floor(canvas.height * 0.04)));
  const lines = wrapCta(text).split("\n");
  const longest = Math.max(...lines.map((line) => [...line].length), 1);
  const preferred = Math.max(1, Math.floor(canvas.height * 0.045));
  const boxBorder = Math.max(1, Math.floor(canvas.height * 0.01));
  const availableWidth = canvas.width - 2 * (marginX + boxBorder);
  const availableHeight = canvas.height - 2 * (marginY + boxBorder);
  const fontSize = Math.min(
    preferred,
    Math.floor(availableWidth / longest),
    Math.floor(availableHeight / (lines.length * 1.25)),
  );
  if (fontSize < 1) {
    throw terminal(
      "ASSEMBLY_OVERLAY_BOUNDS_INVALID",
      "CTA cannot fit inside the output canvas.",
    );
  }
  return {
    fontSize,
    boxBorder,
    x: position.endsWith("RIGHT")
      ? `w-tw-${marginX + boxBorder}`
      : String(marginX + boxBorder),
    y: position.startsWith("BOTTOM")
      ? `h-th-${marginY + boxBorder}`
      : String(marginY + boxBorder),
  };
}

function wrapCta(value: string): string {
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > 120)
    throw terminal("ASSEMBLY_CTA_INVALID", "CTA text is invalid.");
  if (normalized.length <= 48) return normalized;
  const split = normalized.lastIndexOf(" ", 60);
  const index = split >= 24 ? split : 60;
  return `${normalized.slice(0, index).trim()}\n${normalized.slice(index).trim()}`;
}

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

async function runFfmpeg(
  command: string,
  args: string[],
  signal: AbortSignal,
  onProgress: (processedMs: number) => void,
) {
  const child = spawn(command, args, {
    signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let pending = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("out_time_us=")) {
        const value = Number(line.slice(12));
        if (Number.isFinite(value)) onProgress(Math.round(value / 1_000));
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-128 * 1024);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0)
    throw terminal(
      "ASSEMBLY_FFMPEG_FAILED",
      "FFmpeg could not assemble the horizontal MP4.",
    );
  return { stderr };
}

async function runProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
) {
  const child = spawn(command, args, {
    signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-2 * 1024 * 1024);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0)
    throw terminal(
      "ASSEMBLY_PROCESS_FAILED",
      "A required media operation failed.",
    );
  return { stdout, stderr };
}

function firstLine(value: string, fallback: string): string {
  return value.split("\n")[0]?.trim().slice(0, 200) || fallback;
}

function terminal(code: string, message: string): ControlledMediaError {
  return new ControlledMediaError(code, message, false);
}
