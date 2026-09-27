import { describe, expect, it, vi } from "vitest";

import { createClipGenerationApi } from "../app/shared/api/clip-generation";

describe("clip generation API", () => {
  it("parses durable intents and suggestions", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                projectId: "00000000-0000-4000-8000-000000000002",
                state: "READY",
                provider: "OPENAI",
                model: "gpt-test",
                failureCode: null,
                failureMessage: null,
                createdAt: "2026-09-28T00:00:00.000Z",
                updatedAt: "2026-09-28T00:01:00.000Z",
                suggestions: [
                  {
                    id: "00000000-0000-4000-8000-000000000003",
                    ordinal: 0,
                    startMs: 10_000,
                    endMs: 40_000,
                    title: "Moment",
                    rationale: "Complete story",
                    confidenceBasisPoints: 8_200,
                  },
                ],
              },
            ],
          }),
        ),
    );
    const result = await createClipGenerationApi("/api/v1", fetcher).list(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(result.items[0]?.suggestions[0]?.startMs).toBe(10_000);
  });

  it("sends the exact selected suggestion ids with an idempotency key", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requestId: "00000000-0000-4000-8000-000000000004",
            projectId: "00000000-0000-4000-8000-000000000002",
            jobs: [{ id: "00000000-0000-4000-8000-000000000005" }],
          }),
        ),
    );
    await createClipGenerationApi("/api/v1", fetcher).accept({
      intentId: "00000000-0000-4000-8000-000000000001",
      suggestionIds: ["00000000-0000-4000-8000-000000000003"],
      idempotencyKey: "clip-accept-key",
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toContain(
      "/clip-generations/00000000-0000-4000-8000-000000000001/accept",
    );
    expect(init?.headers).toMatchObject({
      "Idempotency-Key": "clip-accept-key",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      suggestionIds: ["00000000-0000-4000-8000-000000000003"],
    });
  });
});
