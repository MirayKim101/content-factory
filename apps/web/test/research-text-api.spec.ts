import { describe, expect, it } from "vitest";

import { createResearchTextApi } from "../app/shared/api/research-text";

const response = {
  id: "22222222-2222-4222-8222-222222222222",
  transcriptIntentId: "11111111-1111-4111-8111-111111111111",
  state: "QUEUED",
  snapshot: {
    contractVersion: "editorial-research-v1",
    adapterVersion: "local-manual-research-v1",
    query: "topic",
    freshness: "CURRENT",
    searchedAt: "2026-09-24T00:00:00.000Z",
    freshUntil: "2026-09-25T00:00:00.000Z",
    freshnessPolicyVersion: "research-freshness-24h-v1",
    citations: [],
  },
  suggestion: null,
  cost: null,
  failure: null,
};

describe("research text api", () => {
  it("creates a durable request with idempotency and no client-owned provenance", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(String(input)).toContain("/transcript-evidence/");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("key-1");
      expect(JSON.parse(String(init?.body))).toEqual({
        query: "topic",
        citations: [],
      });
      return new Response(JSON.stringify(response), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await createResearchTextApi("/api/v1", fetchMock).create(
      response.transcriptIntentId,
      "key-1",
      { query: "topic", citations: [] },
    );
    expect(result.id).toBe(response.id);
    expect(result.suggestion).toBeNull();
  });

  it("reloads a durable result", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ ...response, state: "READY" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const result = await createResearchTextApi("/api/v1", fetchMock).detail(
      response.id,
    );
    expect(result.state).toBe("READY");
  });

  it("applies the exact current editorial revision with idempotency", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(String(input)).toContain(
        `/research-suggestions/${response.id}/apply-metadata`,
      );
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
        "apply-key-1",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedEditorialRevision: 3,
        title: "Title",
        description: "Description",
        tags: ["one"],
      });
      return new Response(
        JSON.stringify({
          packageId: "33333333-3333-4333-8333-333333333333",
          packageRevisionId: "44444444-4444-4444-8444-444444444444",
          revision: 4,
          title: "Title",
          description: "Description",
          tags: ["one"],
          metadataMode: "AI_ASSISTED",
          thumbnailAssetId: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await createResearchTextApi(
      "/api/v1",
      fetchMock,
    ).applyMetadata(response.id, "apply-key-1", {
      expectedEditorialRevision: 3,
      title: "Title",
      description: "Description",
      tags: ["one"],
    });
    expect(result).toMatchObject({ revision: 4, metadataMode: "AI_ASSISTED" });
  });
});
