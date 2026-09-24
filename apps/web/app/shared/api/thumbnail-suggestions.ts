import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

type ThumbnailCandidate = components["schemas"]["ImageCandidateResponseDto"];
export type ThumbnailSuggestion = components["schemas"]["ImageSuggestionResponseDto"];
export type ThumbnailSuggestionApply = components["schemas"]["ImageSuggestionApplyResponseDto"];
type ThumbnailSuggestionList = components["schemas"]["ImageSuggestionListResponseDto"];
type CreateThumbnailSuggestion = components["schemas"]["CreateImageSuggestionDto"];

const candidateSchema: z.ZodType<ThumbnailCandidate> = z.object({
  id: z.uuid(), contentType: z.literal("image/png"), sizeBytes: z.string().regex(/^\d+$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive(), height: z.number().int().positive(),
  likeness: z.literal("NONE"), safetyDecision: z.object({ version: z.literal("no-likeness-safety-v1"), realisticPersonRequested: z.literal(false), referenceImageUsed: z.literal(false), externalProviderUsed: z.literal(false) }), directCostMicrousd: z.string().regex(/^\d+$/), costBasisVersion: z.string(),
});
const suggestionSchema: z.ZodType<ThumbnailSuggestion> = z.object({
  id: z.uuid(), projectId: z.uuid(), cutPipelineJobId: z.uuid(), state: z.enum(["QUEUED", "PROCESSING", "READY", "FAILED_FINAL"]),
  contractVersion: z.literal("editorial-thumbnail-v1"), adapterVersion: z.string(), promptBasisVersion: z.string(),
  candidate: candidateSchema.nullable(), failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const listSchema: z.ZodType<ThumbnailSuggestionList> = z.object({ items: z.array(suggestionSchema) });
const applySchema: z.ZodType<ThumbnailSuggestionApply> = z.object({ packageId: z.uuid(), packageRevisionId: z.uuid(), revision: z.number().int().positive(), thumbnailAssetId: z.uuid(), thumbnailMode: z.literal("AI_ASSISTED") });

export class ThumbnailSuggestionApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "ThumbnailSuggestionApiError"; }
}

export function createThumbnailSuggestionsApi(apiBasePath: unknown, fetchImplementation: typeof fetch = fetch) {
  const base = parseApiBasePath(apiBasePath);
  const request = async (url: string, init?: RequestInit) => {
    let response: Response;
    try { response = await fetchImplementation(url, init); } catch { throw new Error("NETWORK_ERROR"); }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
      throw new ThumbnailSuggestionApiError(response.status, parsed.success ? parsed.data.error.code : "THUMBNAIL_SUGGESTION_REQUEST_FAILED");
    }
    return payload;
  };
  const path = (projectId: string, jobId: string) => `${base}/projects/${encodeURIComponent(projectId)}/pipeline-jobs/${encodeURIComponent(jobId)}/image-suggestions`;
  return {
    async list(projectId: string, jobId: string) { return listSchema.parse(await request(path(projectId, jobId))).items; },
    async detail(projectId: string, jobId: string, intentId: string) { return suggestionSchema.parse(await request(`${path(projectId, jobId)}/${encodeURIComponent(intentId)}`)); },
    async create(projectId: string, jobId: string, key: string, body: CreateThumbnailSuggestion) {
      return suggestionSchema.parse(await request(path(projectId, jobId), { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
    },
    contentUrl(projectId: string, jobId: string, intentId: string, candidateId: string) { return `${path(projectId, jobId)}/${encodeURIComponent(intentId)}/candidates/${encodeURIComponent(candidateId)}/content`; },
    async apply(projectId: string, jobId: string, intentId: string, key: string, expectedEditorialRevision: number) {
      return applySchema.parse(await request(`${path(projectId, jobId)}/${encodeURIComponent(intentId)}/apply`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ expectedEditorialRevision }) }));
    },
  };
}
