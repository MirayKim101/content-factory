import { describe, expect, it, vi } from "vitest";

import { ResearchController } from "../src/ai-content/research/research.controller.js";

describe("ResearchController", () => {
  it("persists and dispatches cited suggestions without client provenance", async () => {
    process.env.RESEARCH_TEXT_ENABLED = "1";
    const detail = {
      id: "22222222-2222-4222-8222-222222222222",
      transcriptIntentId: "11111111-1111-4111-8111-111111111111",
      state: "QUEUED",
      snapshot: { citations: [] },
    };
    const repository = {
      create: vi.fn().mockResolvedValue(detail.id),
      detail: vi.fn().mockResolvedValue(detail),
      list: vi.fn(),
    };
    const dispatch = { dispatch: vi.fn().mockResolvedValue(undefined) };
    const applyMetadata = { execute: vi.fn() };
    const controller = new ResearchController(
      repository as never,
      dispatch as never,
      applyMetadata as never,
    );
    const result = await controller.create(
      detail.transcriptIntentId,
      "research-test-1",
      {
        query: "stream topic",
        citations: [
          {
            url: "https://example.com/source",
            title: "Source",
            publisher: "Example",
            excerpt: "Evidence",
          },
        ],
      },
    );
    expect(result).toEqual(detail);
    expect(repository.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ sourceTitle: expect.anything() }),
    );
    expect(dispatch.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: detail.id }),
    );
  });
});
