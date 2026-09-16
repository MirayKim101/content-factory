import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  FRAME_EXTRACTOR_VERSION,
  FRAME_EXTRACTION_RECIPE,
  FRAME_LIMITS,
  frameRequestedPositions,
  validateFrameMeasurements,
} from "@content-factory/contracts";

import type {
  ExtractedFrame,
  FrameExtractionRequest,
  FrameExtractor,
} from "../application/frame-extractor.port.js";
import { ControlledMediaError } from "../domain/media-job.js";

const MAX_PROCESS_TEXT_BYTES = 1024 * 1024;

export function buildFrameArguments(input: {
  sourcePath: string;
  outputPath: string;
  requestedMs: number;
}): string[] {
  if (
    !Number.isSafeInteger(input.requestedMs) ||
    input.requestedMs < 0 ||
    input.requestedMs > FRAME_LIMITS.maxDurationMs
  )
    throw unsupportedTiming();
  // Work in display pixels so square-SAR output preserves anamorphic input DAR.
  const filter = [
    "settb=AVTB",
    "setpts=PTS-STARTPTS",
    `select='gte(pts,${input.requestedMs * 1000})*isnan(prev_selected_t)'`,
    "scale=w='min(2*floor(iw*sar/2),2*round(iw*sar*min(1,640/max(iw*sar,ih))/2))':h='min(2*floor(ih/2),2*round(ih*min(1,640/max(iw*sar,ih))/2))':flags=lanczos",
    "setsar=1",
    "showinfo",
  ].join(",");
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "info",
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    input.sourcePath,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-vf",
    filter,
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
    input.outputPath,
  ];
}

/** Require one selected frame and its declared normalized time base. */
export function parseSelectedFrameTiming(stderr: string): {
  actualPtsTicks: number;
  width: number;
  height: number;
} {
  const configs = [
    ...stderr.matchAll(
      /\[Parsed_showinfo_[^\]]+\]\s+config in time_base:\s*(\d+)\/(\d+)/g,
    ),
  ];
  const records = [
    ...stderr.matchAll(
      /\[Parsed_showinfo_[^\]]+\]\s+n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*([^\s]+)[^\r\n]*?\ss:(\d+)x(\d+)\s/g,
    ),
  ];
  if (
    configs.length !== 1 ||
    configs[0]?.[1] !== "1" ||
    configs[0]?.[2] !== "1000000" ||
    records.length !== 1 ||
    records[0]?.[1] !== "0"
  )
    throw unsupportedTiming();
  const record = records[0]!;
  const actualPtsTicks = Number(record[2]);
  const seconds = Number(record[3]);
  const width = Number(record[4]);
  const height = Number(record[5]);
  if (
    !Number.isSafeInteger(actualPtsTicks) ||
    actualPtsTicks < 0 ||
    !Number.isFinite(seconds) ||
    Math.abs(seconds * 1_000_000 - actualPtsTicks) > 1000 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    Math.max(width, height) > FRAME_LIMITS.maxDimension
  )
    throw unsupportedTiming();
  return { actualPtsTicks, width, height };
}

/** Stream duration excludes a non-zero presentation origin; format duration may not. */
export function parseFramePresentationDuration(stdout: string): number {
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ duration_ts?: unknown; time_base?: unknown }>;
    };
    if (parsed.streams?.length !== 1) throw unsupportedTiming();
    const stream = parsed.streams[0]!;
    const durationTicks = Number(stream.duration_ts);
    const fraction = String(stream.time_base).match(/^(\d+)\/(\d+)$/);
    const numerator = Number(fraction?.[1]);
    const denominator = Number(fraction?.[2]);
    const normalized = Math.ceil(
      (durationTicks * numerator * 1_000_000) / denominator,
    );
    if (
      !Number.isSafeInteger(durationTicks) ||
      durationTicks <= 0 ||
      numerator <= 0 ||
      denominator <= 0 ||
      !Number.isSafeInteger(normalized) ||
      normalized <= 0
    )
      throw unsupportedTiming();
    return normalized;
  } catch {
    throw unsupportedTiming();
  }
}

export class FfmpegFrameExtractor implements FrameExtractor {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
    private readonly timeoutPath = "timeout",
  ) {}

  async verifyAvailable(): Promise<void> {
    const deadline = new Date(Date.now() + 10_000);
    const signal = AbortSignal.timeout(10_000);
    // Fail closed at startup when the independent OS watchdog is unavailable.
    const version = await runFrameProcess(
      this.timeoutPath,
      this.ffmpegPath,
      ["-version"],
      deadline,
      signal,
    );
    requirePinnedVersion(version.stdout);
    await runFrameProcess(
      this.timeoutPath,
      this.ffprobePath,
      ["-version"],
      deadline,
      signal,
    );
  }

  async extract(
    input: FrameExtractionRequest,
  ): Promise<readonly ExtractedFrame[]> {
    const positions = frameRequestedPositions(
      input.cutStartMs,
      input.cutEndMs,
      input.inputSizeBytes,
    );
    const invoke = (command: string, args: string[]) =>
      runFrameProcess(
        this.timeoutPath,
        command,
        args,
        input.workDeadlineAt,
        input.signal,
      );
    const version = await invoke(this.ffmpegPath, ["-version"]);
    const ffmpegVersion = version.stdout.split(/\r?\n/, 1)[0] ?? "";
    requirePinnedVersion(ffmpegVersion);
    const probe = await invoke(this.ffprobePath, [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=duration_ts,time_base,width,height,sample_aspect_ratio",
      "-of",
      "json",
      input.sourcePath,
    ]);
    const presentationDurationTicks = parseFramePresentationDuration(
      probe.stdout,
    );
    const geometry = parseInputDisplayGeometry(probe.stdout);
    const frames: ExtractedFrame[] = [];
    for (const [ordinal, requestedCutMs] of positions.entries()) {
      input.signal.throwIfAborted();
      const filePath = join(input.outputDirectory, `frame-${ordinal}.jpg`);
      const result = await invoke(
        this.ffmpegPath,
        buildFrameArguments({
          sourcePath: input.sourcePath,
          outputPath: filePath,
          requestedMs: requestedCutMs,
        }),
      );
      const timing = parseSelectedFrameTiming(result.stderr);
      await input.onMeasuredProgress("EXTRACT", ordinal + 1);
      const metadata = await stat(filePath);
      if (
        !metadata.isFile() ||
        metadata.size <= 0 ||
        metadata.size > FRAME_LIMITS.maxFrameBytes
      ) {
        throw new ControlledMediaError(
          "FRAME_OUTPUT_INVALID",
          "Кадр превышает допустимый размер.",
          false,
        );
      }
      const imageProbe = await invoke(this.ffprobePath, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,sample_aspect_ratio",
        "-of",
        "json",
        filePath,
      ]);
      validateJpegProbe(imageProbe.stdout, timing, geometry);
      await invoke(this.ffmpegPath, [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-err_detect",
        "explode",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        filePath,
        "-map",
        "0:v:0",
        "-f",
        "null",
        "-",
      ]);
      const bytes = await readFile(filePath, { signal: input.signal });
      if (
        bytes.length !== metadata.size ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes.at(-2) !== 0xff ||
        bytes.at(-1) !== 0xd9
      ) {
        throw new ControlledMediaError(
          "FRAME_OUTPUT_INVALID",
          "Не удалось проверить изображение кадра.",
          false,
        );
      }
      frames.push({
        filePath,
        measurement: {
          ordinal,
          requestedCutMs,
          requestedSourceMs: input.cutStartMs + requestedCutMs,
          ...timing,
          timeBaseNumerator: 1,
          timeBaseDenominator: 1_000_000,
          actualCutMs: timing.actualPtsTicks / 1000,
          mappedSourceMs: input.cutStartMs + timing.actualPtsTicks / 1000,
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          contentType: "image/jpeg",
          recipeVersion: FRAME_EXTRACTION_RECIPE,
          extractorVersion: FRAME_EXTRACTOR_VERSION,
          ffmpegVersion,
        },
      });
      await input.onMeasuredProgress("HASH", ordinal + 1);
    }
    try {
      validateFrameMeasurements(
        frames.map((frame) => frame.measurement),
        positions,
        input.cutStartMs,
        presentationDurationTicks,
      );
    } catch {
      throw unsupportedTiming();
    }
    return frames;
  }
}

/** All invocations inherit the immutable attempt deadline, including probes. */
export async function runFrameProcess(
  watchdog: string,
  command: string,
  args: string[],
  deadline: Date,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  signal.throwIfAborted();
  const remainingMs = deadline.getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0)
    throw deadlineExceeded();
  return new Promise((resolve, reject) => {
    const child = spawn(
      watchdog,
      [
        "--signal=TERM",
        "--kill-after=10s",
        `${Math.max(0.001, remainingMs / 1000).toFixed(3)}s`,
        command,
        ...args,
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let spawnError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
      killTimer ??= setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }, FRAME_LIMITS.killGraceMs);
    };
    const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
      if (
        Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length >
        MAX_PROCESS_TEXT_BYTES
      ) {
        overflow = true;
        terminate();
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    child.on("close", (code) => {
      signal.removeEventListener("abort", terminate);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (spawnError)
        reject(
          new ControlledMediaError(
            "FRAME_WATCHDOG_UNAVAILABLE",
            "Обработчик кадров недоступен.",
            false,
          ),
        );
      else if (signal.aborted) reject(signal.reason);
      else if (overflow)
        reject(
          new ControlledMediaError(
            "FRAME_PROCESS_OUTPUT_LIMIT",
            "Обработчик превысил лимит диагностических данных.",
            false,
          ),
        );
      else if (code === 124 || Date.now() >= deadline.getTime())
        reject(deadlineExceeded());
      else if (code !== 0) reject(unsupportedTiming());
      else resolve({ stdout, stderr });
    });
  });
}

function unsupportedTiming(): ControlledMediaError {
  return new ControlledMediaError(
    "FRAME_TIMING_UNSUPPORTED",
    "Не удалось подтвердить точное время кадров.",
    false,
  );
}

function requirePinnedVersion(version: string): void {
  if (!/^ffmpeg version 5\.1\.9(?:[\s-]|$)/.test(version)) {
    throw new ControlledMediaError(
      "FRAME_EXTRACTOR_UNSUPPORTED",
      "Версия обработчика кадров не поддерживается.",
      false,
    );
  }
}

export function parseInputDisplayGeometry(stdout: string): {
  width: number;
  height: number;
} {
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        width?: unknown;
        height?: unknown;
        sample_aspect_ratio?: unknown;
      }>;
    };
    if (parsed.streams?.length !== 1) throw unsupportedTiming();
    const stream = parsed.streams[0]!;
    const sar = String(stream.sample_aspect_ratio).match(/^(\d+):(\d+)$/);
    const numerator = Number(sar?.[1]);
    const denominator = Number(sar?.[2]);
    const width = (Number(stream.width) * numerator) / denominator;
    const height = Number(stream.height);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      numerator <= 0 ||
      denominator <= 0 ||
      width < 2 ||
      height < 2
    )
      throw unsupportedTiming();
    return { width, height };
  } catch {
    throw unsupportedTiming();
  }
}

export function validateJpegProbe(
  stdout: string,
  timing: { width: number; height: number },
  original: { width: number; height: number },
): void {
  try {
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{
        codec_name?: unknown;
        width?: unknown;
        height?: unknown;
        sample_aspect_ratio?: unknown;
      }>;
    };
    const stream = parsed.streams?.[0];
    if (
      parsed.streams?.length !== 1 ||
      !stream ||
      stream.codec_name !== "mjpeg" ||
      stream.width !== timing.width ||
      stream.height !== timing.height ||
      stream.sample_aspect_ratio !== "1:1" ||
      timing.width > original.width ||
      timing.height > original.height
    )
      throw unsupportedTiming();
    const factor = Math.min(1, 640 / Math.max(original.width, original.height));
    const width = Math.min(
      2 * Math.floor(original.width / 2),
      2 * Math.round((original.width * factor) / 2),
    );
    const height = Math.min(
      2 * Math.floor(original.height / 2),
      2 * Math.round((original.height * factor) / 2),
    );
    if (timing.width !== width || timing.height !== height)
      throw unsupportedTiming();
    // Independently bound aspect error; matching the rounding formula alone
    // cannot prove display fidelity for tiny/anamorphic inputs.
    const relativeAspectError = Math.abs(
      timing.width / timing.height / (original.width / original.height) - 1,
    );
    if (relativeAspectError > 0.01) throw unsupportedTiming();
  } catch {
    throw unsupportedTiming();
  }
}

function deadlineExceeded(): ControlledMediaError {
  return new ControlledMediaError(
    "FRAME_WORK_DEADLINE_EXCEEDED",
    "Превышено время обработки кадров.",
    false,
  );
}
