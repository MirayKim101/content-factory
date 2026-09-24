import { describe, expect, it, vi } from "vitest";
import { ResearchController } from "../src/ai-content/research/research.controller.js";

describe("ResearchController", () => {
  it("returns cited deterministic text suggestions without changing editorial state", async () => {
    const repository = { detail: vi.fn().mockResolvedValue({ id: "intent" }) };
    const controller = new ResearchController(repository as never);
    const result = await controller.suggest(
      "11111111-1111-4111-8111-111111111111",
      {
        query: "stream topic",
        sourceTitle: "Stream title",
        citations: [
          {
            url: "https://example.com/source",
            title: "Source",
            publisher: "Example",
            accessedAt: "2026-09-23T00:00:00.000Z",
            excerpt: "Evidence",
          },
        ],
      },
    );
    expect(result.suggestion.citationIds).toHaveLength(1);
    expect(result.snapshot.citations[0]?.url).toBe(
      "https://example.com/source",
    );
    expect(result.snapshot.citations).toHaveLength(1);
    expect(repository.detail).toHaveBeenCalledOnce();
  });
});
