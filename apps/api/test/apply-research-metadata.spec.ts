import { describe, expect, it, vi } from "vitest";

import { ApplyResearchMetadata } from "../src/ai-content/application/apply-research-metadata.js";

const suggestion = {
  id: "00000000-0000-4000-8000-000000000004",
  title: "Exact title",
  description: "Exact description",
  tags: ["one", "two"],
  basisVersion: "editorial-research-v1:local-manual-research-v1",
  citationIds: [],
  claims: [],
};

function service() {
  const repository = {
    resolveForApply: vi.fn().mockResolvedValue({
      pipelineJobId: "00000000-0000-4000-8000-000000000001",
      researchIntentId: "00000000-0000-4000-8000-000000000002",
      suggestionSetId: "00000000-0000-4000-8000-000000000003",
      suggestion,
    }),
  };
  const editorial = { apply: vi.fn().mockResolvedValue({ id: "package" }) };
  return {
    value: new ApplyResearchMetadata(repository as never, editorial as never),
    editorial,
  };
}

describe("ApplyResearchMetadata", () => {
  it("derives AI_ASSISTED only for exact normalized candidate metadata", async () => {
    const { value, editorial } = service();
    await value.execute({
      researchIntentId: "00000000-0000-4000-8000-000000000002",
      expectedEditorialRevision: 2,
      idempotencyKey: "apply-1",
      title: " Exact title ",
      description: "Exact description",
      tags: ["one", "two"],
    });
    expect(editorial.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 2,
        provenance: expect.objectContaining({ mode: "AI_ASSISTED" }),
      }),
    );
  });

  it("derives MIXED when the operator changes any metadata field", async () => {
    const { value, editorial } = service();
    await value.execute({
      researchIntentId: "00000000-0000-4000-8000-000000000002",
      expectedEditorialRevision: 2,
      idempotencyKey: "apply-2",
      title: "Edited title",
      description: suggestion.description,
      tags: [...suggestion.tags],
    });
    expect(editorial.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({ mode: "MIXED" }),
      }),
    );
  });
});
