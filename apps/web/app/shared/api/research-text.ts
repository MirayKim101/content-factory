import { z } from "zod";

import { parseApiBasePath } from "~/shared/config/api-config";

const citationSchema = z.object({
  url: z.url(),
  title: z.string(),
  publisher: z.string(),
  retrievedAt: z.iso.datetime(),
  excerpt: z.string(),
});

const suggestionSchema = z.object({
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  basisVersion: z.string(),
  mode: z.enum(["AI_ASSISTED", "MIXED"]),
});

const responseSchema = z.object({
  intentId: z.uuid(),
  snapshot: z.object({
    contractVersion: z.literal("editorial-research-v1"),
    adapterVersion: z.string(),
    query: z.string(),
    freshness: z.enum(["CURRENT", "STALE"]),
    citations: z.array(citationSchema),
  }),
  suggestion: suggestionSchema,
});

export type ResearchCitation = z.infer<typeof citationSchema>;
export type ResearchSuggestionResponse = z.infer<typeof responseSchema>;

export function createResearchTextApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    async suggest(
      intentId: string,
      input: {
        query: string;
        sourceTitle: string;
        citations: ResearchCitation[];
      },
    ): Promise<ResearchSuggestionResponse> {
      let response: Response;
      try {
        response = await fetchImplementation(
          `${basePath}/transcript-evidence/${encodeURIComponent(intentId)}/research-suggestions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
        );
      } catch {
        throw new Error("NETWORK_ERROR");
      }
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error("RESEARCH_REQUEST_FAILED");
      return responseSchema.parse(payload);
    },
  };
}
