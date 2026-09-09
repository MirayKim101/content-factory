import { spawn } from "node:child_process";

import {
  FinalMediaError,
  RetryableMediaError,
  type MediaRuntime,
} from "@content-factory/manual-cut";

export class FfmpegMediaRuntime implements MediaRuntime {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
    private readonly timeoutMs: number,
  ) {}

  async probe(input: { inputPath: string; signal: AbortSignal }) {
    let output: string;
    try {
      output = await runProcess(
        this.ffprobePath,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_type,codec_name",
          "-of",
          "json",
          input.inputPath,
        ],
        input.signal,
        this.timeoutMs,
      );
    } catch (error) {
      if (
        error instanceof RetryableMediaError &&
        error.code === "MEDIA_TIMEOUT"
      )
        throw error;
      if (input.signal.aborted) throw error;
      throw new FinalMediaError(
        "INVALID_SOURCE_MEDIA",
        "The media file could not be inspected.",
      );
    }
    try {
      const parsed = JSON.parse(output) as {
        format?: { duration?: string };
        streams?: Array<{ codec_type?: string; codec_name?: string }>;
      };
      const durationMs = Math.round(Number(parsed.format?.duration) * 1_000);
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
        throw new Error("duration");
      return {
        durationMs,
        streams: (parsed.streams ?? []).flatMap((stream) =>
          stream.codec_type
            ? [
                {
                  type: stream.codec_type,
                  ...(stream.codec_name ? { codec: stream.codec_name } : {}),
                },
              ]
            : [],
        ),
      };
    } catch {
      throw new FinalMediaError(
        "INVALID_SOURCE_MEDIA",
        "The media metadata is invalid.",
      );
    }
  }

  async cut(input: {
    inputPath: string;
    outputPath: string;
    startMs: number;
    endMs: number;
    recipe: "horizontal-cut-v1";
    signal: AbortSignal;
    onProgress(encodedMs: number): void;
  }): Promise<void> {
    if (input.recipe !== "horizontal-cut-v1")
      throw new FinalMediaError(
        "UNSUPPORTED_RECIPE",
        "The cut recipe is unsupported.",
      );
    const progress = await runProcess(
      this.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        seconds(input.startMs),
        "-i",
        input.inputPath,
        "-t",
        seconds(input.endMs - input.startMs),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-maxrate",
        "5M",
        "-bufsize",
        "10M",
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
        "-y",
        input.outputPath,
      ],
      input.signal,
      this.timeoutMs,
      (chunk) => {
        for (const match of chunk.matchAll(/out_time_ms=(\d+)/g)) {
          const microseconds = Number(match[1]);
          if (Number.isSafeInteger(microseconds))
            input.onProgress(Math.round(microseconds / 1_000));
        }
      },
    );
    void progress;
  }
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

async function runProcess(
  executable: string,
  arguments_: string[],
  callerSignal: AbortSignal,
  timeoutMs: number,
  onStdout?: (chunk: string) => void,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([callerSignal, timeout]);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = bounded(stdout + chunk);
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = bounded(stderr + chunk);
    });
    child.once("error", (error) => {
      if (timeout.aborted)
        reject(
          new RetryableMediaError(
            "MEDIA_TIMEOUT",
            "Media processing timed out.",
          ),
        );
      else if (callerSignal.aborted) reject(callerSignal.reason ?? error);
      else reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else if (signal.aborted) reject(signal.reason);
      else
        reject(
          new RetryableMediaError(
            "MEDIA_PROCESSING_FAILED",
            "The media process failed.",
          ),
        );
    });
  });
}

function bounded(value: string): string {
  return value.length <= 64 * 1024 ? value : value.slice(-64 * 1024);
}
