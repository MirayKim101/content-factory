import { spawn } from "node:child_process";

import type { MediaProcessor } from "../application/ports.js";
import { ControlledMediaError } from "../domain/media-job.js";

export class FfmpegMediaProcessor implements MediaProcessor {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  async probe(
    filePath: string,
    signal: AbortSignal,
  ): Promise<{ durationMs: number; version: string }> {
    const [probe, version] = await Promise.all([
      runProcess(
        this.ffprobePath,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          filePath,
        ],
        signal,
      ),
      runProcess(this.ffprobePath, ["-version"], signal),
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(probe.stdout);
    } catch {
      throw new ControlledMediaError(
        "SOURCE_PROBE_INVALID",
        "Не удалось определить длительность исходного видео.",
        false,
      );
    }
    const duration = Number(
      (parsed as { format?: { duration?: unknown } }).format?.duration,
    );
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new ControlledMediaError(
        "SOURCE_PROBE_INVALID",
        "Не удалось определить длительность исходного видео.",
        false,
      );
    }
    return {
      durationMs: Math.round(duration * 1_000),
      version: firstLine(version.stdout, "ffprobe-unknown"),
    };
  }

  async inspectOutput(
    filePath: string,
    signal: AbortSignal,
  ): Promise<{
    durationMs: number;
    hasVideo: boolean;
    frameRate?: number;
    version: string;
  }> {
    let probe;
    let version;
    try {
      [probe, version] = await Promise.all([
        runProcess(
          this.ffprobePath,
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,avg_frame_rate,r_frame_rate",
            "-of",
            "json",
            filePath,
          ],
          signal,
        ),
        runProcess(this.ffprobePath, ["-version"], signal),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || signal.aborted)
      ) {
        throw error;
      }
      throw invalidOutput();
    }

    return parseOutputProbe(probe.stdout, version.stdout);
  }

  async cut(input: {
    recipeVersion: string;
    sourcePath: string;
    outputPath: string;
    startMs: number;
    endMs: number;
    signal: AbortSignal;
    onProgress(processedMs: number): void;
  }): Promise<{ version: string }> {
    const process = spawn(this.ffmpegPath, buildCutArguments(input), {
      signal: input.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("out_time_us=")) {
          const microseconds = Number(line.slice("out_time_us=".length));
          if (Number.isFinite(microseconds))
            input.onProgress(Math.round(microseconds / 1_000));
        }
      }
    });
    process.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      process.once("error", reject);
      process.once("close", resolve);
    });
    if (code !== 0) {
      throw new ControlledMediaError(
        "FFMPEG_CUT_FAILED",
        "FFmpeg не смог создать воспроизводимый MP4 из выбранного отрезка.",
        false,
      );
    }
    const version = await runProcess(
      this.ffmpegPath,
      ["-version"],
      input.signal,
    );
    return { version: firstLine(version.stdout, "ffmpeg-unknown") };
  }
}

export function buildCutArguments(input: {
  recipeVersion: string;
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
}): string[] {
  const preset = encoderPreset(input.recipeVersion);
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    seconds(input.startMs),
    "-i",
    input.sourcePath,
    "-t",
    seconds(input.endMs - input.startMs),
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
    input.outputPath,
  ];
}

function encoderPreset(recipeVersion: string): "medium" | "veryfast" {
  if (recipeVersion === "stage1-cut-h264-v1") return "medium";
  if (recipeVersion === "stage1-cut-h264-v2") return "veryfast";
  throw new ControlledMediaError(
    "CUT_RECIPE_UNSUPPORTED",
    "Версия настроек обработки этого задания не поддерживается.",
    false,
  );
}

export function parseOutputProbe(
  stdout: string,
  versionOutput: string,
): {
  durationMs: number;
  hasVideo: boolean;
  frameRate?: number;
  version: string;
} {
  let parsed: {
    format?: { duration?: unknown };
    streams?: Array<{
      codec_type?: unknown;
      avg_frame_rate?: unknown;
      r_frame_rate?: unknown;
    }>;
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw invalidOutput();
  }
  const duration = Number(parsed.format?.duration);
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const frameRate = parseFrameRate(
    video?.avg_frame_rate ?? video?.r_frame_rate,
  );
  return {
    durationMs: Math.round(duration * 1_000),
    hasVideo: Boolean(video),
    ...(frameRate ? { frameRate } : {}),
    version: firstLine(versionOutput, "ffprobe-unknown"),
  };
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
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
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on(
    "data",
    (chunk: string) => (stderr = `${stderr}${chunk}`.slice(-16_384)),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    throw new ControlledMediaError(
      "SOURCE_PROBE_FAILED",
      "Исходный MP4 повреждён или не поддерживается.",
      false,
    );
  }
  return { stdout, stderr };
}

function firstLine(value: string, fallback: string): string {
  return value.split("\n")[0]?.trim().slice(0, 200) || fallback;
}

function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [numeratorRaw, denominatorRaw = "1"] = value.split("/");
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw);
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function invalidOutput(): ControlledMediaError {
  return new ControlledMediaError(
    "CUT_OUTPUT_INVALID",
    "Созданный MP4 не прошёл проверку длительности и видеопотока.",
    false,
  );
}
