import { describe, expect, it } from "vitest";
import { RESEARCH_CONTRACT_VERSION } from "@content-factory/contracts";
import { LocalResearchAdapter } from "../src/ai-content/research/local-research-adapter.js";

describe("LocalResearchAdapter", () => {
  it("creates deterministic editable suggestions without network access", () => {
    const snapshot = {
      contractVersion: RESEARCH_CONTRACT_VERSION,
      adapterVersion: "local-manual-research-v1",
      query: "topic",
      freshness: "CURRENT" as const,
      citations: [
        {
          url: "https://example.com",
          title: "Source",
          publisher: "Example",
          retrievedAt: "2026-09-23T00:00:00.000Z",
          excerpt: "Evidence",
        },
      ],
    };
    const result = new LocalResearchAdapter().suggest({ snapshot, sourceTitle: "Stream" });
    expect(result.mode).toBe("AI_ASSISTED");
    expect(result.basisVersion).toContain(RESEARCH_CONTRACT_VERSION);
    expect(result.tags).toEqual(["Example"]);
  });
});
