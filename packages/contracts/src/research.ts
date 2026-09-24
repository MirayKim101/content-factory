/** Provider-neutral cited research and editable text suggestion boundary. */
export const RESEARCH_CONTRACT_VERSION = "editorial-research-v1" as const;
export const LOCAL_RESEARCH_ADAPTER_VERSION =
  "local-manual-research-v1" as const;

export type ResearchCitation = Readonly<{
  id: string;
  url: string;
  title: string;
  publisher: string;
  publishedAt?: string | null;
  accessedAt: string;
  excerpt: string;
  checksum: string;
}>;

export type ResearchSnapshot = Readonly<{
  contractVersion: typeof RESEARCH_CONTRACT_VERSION;
  adapterVersion: string;
  query: string;
  citations: readonly ResearchCitation[];
  freshness: "CURRENT" | "STALE";
}>;

export type TextSuggestion = Readonly<{
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  basisVersion: string;
  citationIds: readonly string[];
  claims: readonly Readonly<{ text: string; citationIds: readonly string[] }>[];
}>;

export function validateResearchSnapshot(snapshot: ResearchSnapshot): void {
  if (snapshot.contractVersion !== RESEARCH_CONTRACT_VERSION)
    throw new Error("RESEARCH_CONTRACT_INVALID");
  if (!snapshot.query.trim() || snapshot.query.length > 4_000)
    throw new Error("RESEARCH_QUERY_INVALID");
  if (snapshot.citations.length > 100)
    throw new Error("RESEARCH_CITATIONS_INVALID");
  for (const citation of snapshot.citations) {
    let url: URL;
    try {
      url = new URL(citation.url);
    } catch {
      throw new Error("RESEARCH_CITATION_INVALID");
    }
    if (
      url.protocol !== "https:" ||
      !citation.id ||
      !citation.title.trim() ||
      !citation.publisher.trim() ||
      !citation.accessedAt ||
      !citation.excerpt.trim() ||
      !/^[a-f0-9]{64}$/.test(citation.checksum)
    )
      throw new Error("RESEARCH_CITATION_INVALID");
  }
}
