import { describe, expect, it } from "vitest";
import {
  RESEARCH_CONTRACT_VERSION,
  validateResearchSnapshot,
} from "@content-factory/contracts";

describe("research contract", () => {
  it("accepts cited HTTPS snapshots and rejects non-HTTPS citations", () => {
    const snapshot = {
      contractVersion: RESEARCH_CONTRACT_VERSION,
      adapterVersion: "local-manual-research-v1",
      query: "stream topic",
      freshness: "CURRENT" as const,
      citations: [
        {
          id: "citation-1",
          url: "https://example.com/source",
          title: "Source",
          publisher: "Example",
          accessedAt: "2026-09-23T00:00:00.000Z",
          excerpt: "A bounded source excerpt.",
          checksum: "a".repeat(64),
        },
      ],
    };
    expect(() => validateResearchSnapshot(snapshot)).not.toThrow();
    expect(() =>
      validateResearchSnapshot({
        ...snapshot,
        citations: [{ ...snapshot.citations[0], url: "file:///secret" }],
      }),
    ).toThrow("RESEARCH_CITATION_INVALID");
    expect(() =>
      validateResearchSnapshot({
        ...snapshot,
        citations: [{ ...snapshot.citations[0], url: "http://example.com" }],
      }),
    ).toThrow("RESEARCH_CITATION_INVALID");
  });
});
