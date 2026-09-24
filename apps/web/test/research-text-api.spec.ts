import { describe, expect, it } from "vitest";

import { createResearchTextApi } from "../app/shared/api/research-text";

describe("research text api", () => {
  it("posts cited input and validates the suggestion response", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(String(input)).toContain("/transcript-evidence/");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        query: "topic",
        sourceTitle: "Stream",
      });
      return new Response(
        JSON.stringify({
          intentId: "11111111-1111-4111-8111-111111111111",
          snapshot: {
            contractVersion: "editorial-research-v1",
            adapterVersion: "local-manual-research-v1",
            query: "topic",
            freshness: "CURRENT",
            citations: [],
          },
          suggestion: {
            id: "22222222-2222-4222-8222-222222222222",
            title: "Topic",
            description: "Description",
            tags: ["topic"],
            basisVersion: "local-manual-research-v1",
            citationIds: [],
            claims: [],
          },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    };
    const result = await createResearchTextApi("/api/v1", fetchMock).suggest(
      "11111111-1111-4111-8111-111111111111",
      { query: "topic", sourceTitle: "Stream", citations: [] },
    );
    expect(result.suggestion.tags).toEqual(["topic"]);
  });
});
