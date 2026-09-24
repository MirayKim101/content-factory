import { z } from "zod";

import { parseApiBasePath } from "~/shared/config/api-config";

const citationSchema = z.object({
  id: z.uuid(),
  url: z.url().refine((value) => value.startsWith("https://")),
  title: z.string(),
  publisher: z.string(),
  publishedAt: z.iso.datetime().nullable(),
  accessedAt: z.iso.datetime(),
  excerpt: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});

const citationInputSchema = citationSchema.omit({ id: true, checksum: true });

const suggestionSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  basisVersion: z.string(),
  citationIds: z.array(z.uuid()),
  claims: z.array(
    z.object({ text: z.string(), citationIds: z.array(z.uuid()) }),
  ),
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

export type ResearchCitation = z.infer<typeof citationInputSchema>;
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
