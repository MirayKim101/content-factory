import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FinalMediaError,
  RetryableMediaError,
} from "@content-factory/manual-cut";
import { afterEach, describe, expect, it } from "vitest";

import { FfmpegMediaRuntime } from "../src/ffmpeg-media-runtime.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("FfmpegMediaRuntime probe failures", () => {
  it("classifies a nonzero probe as final invalid media", async () => {
    const runtime = new FfmpegMediaRuntime("/bin/false", "/bin/false", 1_000);
    const error = await runtime
      .probe({ inputPath: "ignored.mp4", signal: new AbortController().signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FinalMediaError);
    expect(error).toMatchObject({ code: "INVALID_SOURCE_MEDIA" });
  });

  it("preserves a probe timeout as retryable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "content-factory-probe-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "slow-probe");
    await writeFile(executable, "#!/bin/sh\nsleep 10\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    const runtime = new FfmpegMediaRuntime("/bin/false", executable, 5);
    const error = await runtime
      .probe({ inputPath: "ignored.mp4", signal: new AbortController().signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetryableMediaError);
    expect(error).toMatchObject({ code: "MEDIA_TIMEOUT" });
  });
});
