import { describe, expect, it } from "vitest";

import { LocalClipGenerationAdapter } from "../src/infrastructure/local-clip-generation-adapter.js";

const request = {
  sourceDurationMs: 120_000,
  sourceTitle: "Test stream",
  transcript: [
    { startMs: 5_000, endMs: 12_000, text: "Первый точный момент" },
    { startMs: 70_000, endMs: 82_000, text: "Второй точный момент" },
  ],
  maximumSuggestions: 2,
  minimumClipDurationMs: 15_000,
  maximumClipDurationMs: 60_000,
  language: "ru",
} as const;

describe("LocalClipGenerationAdapter", () => {
  it("returns deterministic valid intervals without network access", async () => {
    const adapter = new LocalClipGenerationAdapter();
    const first = await adapter.generate(request);
    const second = await adapter.generate(request);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      suggestions: [
        { startMs: 5_000, endMs: 20_000, confidenceBasisPoints: 0 },
        { startMs: 70_000, endMs: 85_000, confidenceBasisPoints: 0 },
      ],
    });
  });

  it("honors cancellation before producing a fixture", async () => {
    const abort = new AbortController();
    abort.abort(new Error("TEST_ABORT"));
    await expect(
      new LocalClipGenerationAdapter().generate(request, abort.signal),
    ).rejects.toThrow("TEST_ABORT");
  });
});
