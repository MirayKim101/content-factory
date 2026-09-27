import { describe, expect, it, vi } from "vitest";
import { OpenAiClipGenerationAdapter } from "../src/infrastructure/openai-clip-generation-adapter.js";

const request = {
  sourceDurationMs: 120_000,
  sourceTitle: "Test stream",
  transcript: [{ startMs: 0, endMs: 120_000, text: "A complete moment" }],
  maximumSuggestions: 2,
  minimumClipDurationMs: 10_000,
  maximumClipDurationMs: 60_000,
  language: "en",
} as const;
const success = (endMs = 40_000) => ({
  id: "resp_1",
  status: "completed",
  model: "gpt-test",
  output: [
    {
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            suggestions: [
              {
                startMs: 10_000,
                endMs,
                title: "Moment",
                rationale: "Complete story",
                confidenceBasisPoints: 8_500,
              },
            ],
          }),
        },
      ],
    },
  ],
});

describe("OpenAiClipGenerationAdapter", () => {
  it("uses strict Responses output without provider storage", async () => {
    let captured: RequestInit | undefined;
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        captured = init;
        return new Response(JSON.stringify(success()), { status: 200 });
      },
    );
    const adapter = new OpenAiClipGenerationAdapter(
      { apiKey: "secret", model: "gpt-test", timeoutMs: 1_000 },
      fetch,
    );
    await expect(adapter.generate(request)).resolves.toMatchObject({
      providerRequestId: "resp_1",
      suggestions: [{ startMs: 10_000, endMs: 40_000 }],
    });
    const body = JSON.parse(String(captured?.body));
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(captured?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(captured?.redirect).toBe("error");
  });

  it("rejects intervals outside the duration policy", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(success(15_000))),
    );
    const adapter = new OpenAiClipGenerationAdapter(
      { apiKey: "secret", model: "gpt-test", timeoutMs: 1_000 },
      fetch,
    );
    await expect(adapter.generate(request)).rejects.toThrow(
      "CLIP_GENERATION_OUTPUT_INVALID",
    );
  });

  it("does not hide provider HTTP failures", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
        }),
    );
    const adapter = new OpenAiClipGenerationAdapter(
      { apiKey: "secret", model: "gpt-test", timeoutMs: 1_000 },
      fetch,
    );
    await expect(adapter.generate(request)).rejects.toThrow(
      "CLIP_GENERATION_PROVIDER_HTTP_401:bad key",
    );
  });
});
