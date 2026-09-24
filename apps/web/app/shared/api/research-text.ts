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

const citationInputSchema = citationSchema.omit({
  id: true,
  checksum: true,
  accessedAt: true,
});

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
  id: z.uuid(),
  transcriptIntentId: z.uuid(),
  state: z.enum(["QUEUED", "PROCESSING", "READY", "FAILED_FINAL"]),
  snapshot: z.object({
    contractVersion: z.literal("editorial-research-v1"),
    adapterVersion: z.string(),
    query: z.string(),
    freshness: z.enum(["CURRENT", "STALE"]),
    searchedAt: z.iso.datetime(),
    freshUntil: z.iso.datetime(),
    freshnessPolicyVersion: z.string(),
    citations: z.array(citationSchema),
  }),
  suggestion: suggestionSchema.nullable(),
  cost: z
    .object({
      directCostMicrousd: z.string().regex(/^\d+$/),
      basisVersion: z.string(),
    })
    .nullable(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
});

const listSchema = z.object({ items: z.array(responseSchema) });

const transcriptSchema = z.object({
  id: z.uuid(),
  state: z.enum(["QUEUED", "PROCESSING", "READY", "FAILED_FINAL"]),
  contractVersion: z.literal("editorial-transcript-v1"),
  adapterVersion: z.string(),
  language: z.string(),
  input: z.object({
    projectId: z.uuid(),
    sourceId: z.uuid(),
    sourceVersion: z.number().int().positive(),
    sourceSha256: z.string(),
    sourceAuthorizationRevision: z.number().int().positive(),
    cutPipelineJobId: z.uuid(),
    cutResultArtifactId: z.uuid(),
    cutResultSha256: z.string(),
    cutResultSizeBytes: z.string(),
    cutStartMs: z.number().int().nonnegative(),
    cutEndMs: z.number().int().positive(),
    creatorProfileRevisionId: z.uuid(),
    creatorProfileRevisionNo: z.number().int().positive(),
    sourceContextRevisionId: z.uuid(),
    sourceContextRevisionNo: z.number().int().positive(),
    cutPromptRevisionId: z.uuid(),
    cutPromptRevisionNo: z.number().int().positive(),
  }),
  artifact: z.unknown().nullable(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
});

const applyResponseSchema = z.object({
  packageId: z.uuid(),
  packageRevisionId: z.uuid(),
  revision: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  metadataMode: z.enum(["AI_ASSISTED", "MIXED"]),
  thumbnailAssetId: z.uuid().nullable(),
});

export type ResearchCitationInput = z.infer<typeof citationInputSchema>;
export type ResearchSuggestionResponse = z.infer<typeof responseSchema>;
export type ResearchMetadataApplyResponse = z.infer<typeof applyResponseSchema>;

export class ResearchApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ResearchApiError";
  }
}

export function createResearchTextApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  const request = async (url: string, init?: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImplementation(url, init);
    } catch {
      throw new Error("NETWORK_ERROR");
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = z
        .object({ error: z.object({ code: z.string() }) })
        .safeParse(payload);
      throw new ResearchApiError(
        response.status,
        parsed.success ? parsed.data.error.code : "RESEARCH_REQUEST_FAILED",
      );
    }
    return payload;
  };
  return {
    async latestTranscriptForJob(cutJobId: string) {
      return transcriptSchema.parse(
        await request(
          `${basePath}/pipeline-jobs/${encodeURIComponent(cutJobId)}/transcript-evidence`,
        ),
      );
    },
    async create(
      transcriptIntentId: string,
      idempotencyKey: string,
      input: { query: string; citations: ResearchCitationInput[] },
    ): Promise<ResearchSuggestionResponse> {
      return responseSchema.parse(
        await request(
          `${basePath}/transcript-evidence/${encodeURIComponent(transcriptIntentId)}/research-suggestions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify(input),
          },
        ),
      );
    },
    async list(transcriptIntentId: string) {
      return listSchema.parse(
        await request(
          `${basePath}/transcript-evidence/${encodeURIComponent(transcriptIntentId)}/research-suggestions`,
        ),
      ).items;
    },
    async detail(researchIntentId: string) {
      return responseSchema.parse(
        await request(
          `${basePath}/research-suggestions/${encodeURIComponent(researchIntentId)}`,
        ),
      );
    },
    async applyMetadata(
      researchIntentId: string,
      idempotencyKey: string,
      input: {
        expectedEditorialRevision: number;
        title: string;
        description: string;
        tags: string[];
      },
    ): Promise<ResearchMetadataApplyResponse> {
      return applyResponseSchema.parse(
        await request(
          `${basePath}/research-suggestions/${encodeURIComponent(researchIntentId)}/apply-metadata`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify(input),
          },
        ),
      );
    },
  };
}
