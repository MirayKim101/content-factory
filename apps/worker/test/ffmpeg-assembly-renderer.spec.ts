import { describe, expect, it } from "vitest";

import {
  assemblyCodecThreadArguments,
  assemblyComplexThreadArguments,
} from "../src/infrastructure/ffmpeg-assembly-renderer.js";

describe("FFmpeg assembly thread limits", () => {
  it("builds explicit server-owned codec and complex-filter bounds", () => {
    expect(assemblyCodecThreadArguments(3)).toEqual(["-threads", "3"]);
    expect(assemblyComplexThreadArguments(3)).toEqual([
      "-filter_complex_threads",
      "3",
    ]);
  });
});
