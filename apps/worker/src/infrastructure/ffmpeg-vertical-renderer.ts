import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type {
  VerticalRenderedFile,
  VerticalRenderer,
} from "../application/vertical-render.port.js";

const execFileAsync = promisify(execFile);

export class FfmpegVerticalRenderer implements VerticalRenderer {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  async verifyAvailable(): Promise<void> {
    await Promise.all([
      execFileAsync(this.ffmpegPath, ["-version"]),
      execFileAsync(this.ffprobePath, ["-version"]),
    ]);
  }

  async render(
    input: string,
    output: string,
    signal: AbortSignal,
  ): Promise<VerticalRenderedFile> {
    signal.throwIfAborted();
    await run(this.ffmpegPath, verticalRenderArguments(input, output), signal);
    const { stdout } = await execFileAsync(
      this.ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        output,
      ],
      { signal },
    );
    const probe = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
      }>;
    };
    const video = probe.streams?.find(
      (stream) => stream.codec_type === "video",
    );
    const audio = probe.streams?.find(
      (stream) => stream.codec_type === "audio",
    );
    const durationMs = Math.round(Number(probe.format?.duration) * 1000);
    if (
      !video ||
      !audio ||
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0
    )
      throw new Error("VERTICAL_PROBE_INVALID");
    const version = await execFileAsync(this.ffmpegPath, ["-version"], {
      signal,
    });
    return {
      durationMs,
      width: video.width ?? 0,
      height: video.height ?? 0,
      videoCodec: video.codec_name ?? "",
      audioCodec: audio.codec_name ?? "",
      ffmpegVersion: version.stdout.split("\n")[0]?.slice(0, 255) ?? "ffmpeg",
    };
  }
}

export function verticalRenderArguments(
  input: string,
  output: string,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
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
    output,
  ];
}

function run(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = boundedDiagnosticTail(stderr, String(chunk));
    });
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", reject);
    child.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`VERTICAL_FFMPEG_FAILED:${stderr.slice(-500)}`));
    });
  });
}

export function boundedDiagnosticTail(
  current: string,
  chunk: string,
  maximumCharacters = 4_000,
): string {
  return `${current}${chunk}`.slice(-maximumCharacters);
}
