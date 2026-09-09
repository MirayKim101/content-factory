import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type CreatorProfile = components["schemas"]["CreatorProfileDetailResponseDto"];
export type CreatorProfileSummary = components["schemas"]["CreatorProfileSummaryResponseDto"];
export type CreatorReference = components["schemas"]["CreatorReferenceAssetResponseDto"];
export type SourceContext = components["schemas"]["SourceEditorialContextDetailResponseDto"];
export type CutPrompt = components["schemas"]["CutEditorialPromptDetailResponseDto"];
export type ProfileInput = components["schemas"]["CreatorProfileRevisionInputDto"];
export type SourceContextInput = components["schemas"]["SourceEditorialContextInputDto"];
export type CutPromptInput = components["schemas"]["CutEditorialPromptInputDto"];

const uuid = z.uuid();
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), existingProfileId: uuid.optional() }) });
const authSchema = z.object({ id: uuid, revision: z.number().int(), status: z.enum(["NOT_REVIEWED", "CLEARED", "REVOKED"]), commercialAiImageUseAttested: z.boolean(), externalProviderTransferAllowed: z.boolean(), basis: z.string().nullable(), scope: z.string().nullable(), declarationVersion: z.string().nullable(), expiresAt: z.string().nullable(), createdAt: z.string(), decidedAt: z.string().nullable() });
const referenceSchema = z.object({ id: uuid, creatorProfileId: uuid, originalFilename: z.string(), contentType: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.string(), sha256: z.string(), width: z.number(), height: z.number(), status: z.enum(["PENDING", "READY", "FAILED_FINAL"]), currentAuthorization: authSchema, createdAt: z.string(), updatedAt: z.string() });
const profileInputSchema = z.object({ canonicalDisplayName: z.string(), officialUrl: z.string(), primaryLanguage: z.string(), topics: z.array(z.string()), editorialNotes: z.string(), restrictions: z.array(z.string()) });
const likenessSchema = z.object({ usable: z.boolean(), blocker: z.string().nullable(), externalProviderTransferAllowed: z.boolean() });
const profileRevisionSchema = z.object({ id: uuid, profileId: uuid, revision: z.number().int(), editableRevision: profileInputSchema, likenessPolicy: z.enum(["NO_REALISTIC_LIKENESS", "CLEARED_REFERENCE_ONLY"]), likenessUsability: likenessSchema, defaultReference: z.object({ assetId: uuid, authorizationRevisionId: uuid, authorizationRevision: z.number().int(), authorizationStatus: z.enum(["NOT_REVIEWED", "CLEARED", "REVOKED"]), expiresAt: z.string().nullable(), externalProviderTransferAllowed: z.boolean() }).nullable(), status: z.enum(["CURRENT", "STALE"]), createdAt: z.string(), officialUrlIdentity: z.object({ canonicalUrl: z.string().optional(), canonicalizationVersion: z.string().optional(), id: uuid.optional() }) });
const profileSchema = z.object({ id: uuid, currentRevision: z.number().int(), revision: profileRevisionSchema, createdAt: z.string(), updatedAt: z.string() });
const sourceInputSchema = z.object({ creatorProfileId: uuid, creatorProfileRevision: z.number().int(), sourceTitle: z.string(), gameOrTopic: z.string(), audience: z.string(), editorialGoal: z.string(), language: z.string(), defaultCta: z.string(), restrictions: z.array(z.string()), operatorNotes: z.string() });
const sourceRevisionSchema = z.object({ id: uuid, contextId: uuid, revision: z.number().int(), projectId: uuid, sourceId: uuid, sourceVersion: z.number().int(), creatorProfileRevisionId: uuid, editableRevision: sourceInputSchema, blockers: z.array(z.string()), likenessUsability: likenessSchema, status: z.enum(["CURRENT", "STALE"]), createdAt: z.string() });
const sourceContextSchema = z.object({ id: uuid, currentRevision: z.number().int(), revision: sourceRevisionSchema, createdAt: z.string(), updatedAt: z.string() });
const promptInputSchema = z.object({ sourceContextId: uuid, sourceContextRevision: z.number().int(), whatHappens: z.string(), desiredAngle: z.string(), tone: z.string(), cta: z.string(), restrictions: z.array(z.string()) });
const promptSchema = z.object({ id: uuid, currentRevision: z.number().int(), revision: z.object({ id: uuid, promptId: uuid, revision: z.number().int(), projectId: uuid, sourceId: uuid, sourceVersion: z.number().int(), cutPipelineJobId: uuid, sourceContextRevisionId: uuid, editableRevision: promptInputSchema, blockers: z.array(z.string()), likenessUsability: likenessSchema, contextPolicyFingerprint: z.string(), status: z.enum(["CURRENT", "STALE"]), createdAt: z.string(), cutResultArtifact: z.object({ id: uuid.optional(), sha256: z.string().optional(), sizeBytes: z.string().optional() }) }), createdAt: z.string(), updatedAt: z.string() });

export class CreatorContextApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly existingProfileId?: string) { super(message); this.name = "CreatorContextApiError"; }
}

export function createCreatorContextApi(apiBasePath: unknown, fetchImplementation: typeof fetch = fetch) {
  const base = parseApiBasePath(apiBasePath);
  const request = <T>(path: string, init: RequestInit, schema: z.ZodType<T>) => send(fetchImplementation, `${base}${path}`, init, schema);
  return {
    listProfiles: () => request("/creator-profiles?limit=100", {}, z.object({ items: z.array(z.object({ id: uuid, canonicalDisplayName: z.string(), officialUrl: z.string(), primaryLanguage: z.string(), topics: z.array(z.string()), currentRevision: z.number().int(), likenessAllowed: z.boolean(), likenessPolicy: z.enum(["NO_REALISTIC_LIKENESS", "CLEARED_REFERENCE_ONLY"]), updatedAt: z.string() })), nextCursor: z.string().nullable() }).transform(x => x.items)),
    getProfile: (id: string) => request(`/creator-profiles/${encodeURIComponent(id)}`, {}, profileSchema),
    createProfile: (body: ProfileInput, key: string) => request("/creator-profiles", json("POST", body, key), profileSchema),
    updateProfile: (id: string, body: ProfileInput & { expectedRevision: number }, key: string) => request(`/creator-profiles/${encodeURIComponent(id)}`, json("PUT", body, key), profileSchema),
    listReferences: (id: string) => request(`/creator-profiles/${encodeURIComponent(id)}/reference-assets?limit=100`, {}, z.object({ items: z.array(referenceSchema), nextCursor: z.string().nullable() }).transform(x => x.items)),
    uploadReference: (id: string, file: File, key: string) => { const form = new FormData(); form.set("file", file); return request(`/creator-profiles/${encodeURIComponent(id)}/reference-assets`, { method: "POST", headers: { "Idempotency-Key": key }, body: form }, referenceSchema); },
    updateAuthorization: (profileId: string, assetId: string, body: Record<string, unknown>, key: string) => request(`/creator-profiles/${encodeURIComponent(profileId)}/reference-assets/${encodeURIComponent(assetId)}/authorization`, json("PUT", body, key), z.object({ assetId: uuid, creatorProfileId: uuid, current: authSchema, history: z.array(authSchema) })),
    setDefault: (profileId: string, body: Record<string, unknown>, key: string) => request(`/creator-profiles/${encodeURIComponent(profileId)}/default-reference`, json("PUT", body, key), profileSchema),
    referenceContentUrl: (profileId: string, assetId: string) => `${base}/creator-profiles/${encodeURIComponent(profileId)}/reference-assets/${encodeURIComponent(assetId)}/content`,
    getSourceContext: (projectId: string, sourceId: string, version: number) => request(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/versions/${version}/editorial-context`, {}, sourceContextSchema),
    saveSourceContext: (projectId: string, sourceId: string, version: number, body: SourceContextInput & { expectedRevision: number }, key: string) => request(`/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/versions/${version}/editorial-context`, json("PUT", body, key), sourceContextSchema),
    getCutPrompt: (jobId: string) => request(`/pipeline-jobs/${encodeURIComponent(jobId)}/editorial-prompt`, {}, promptSchema),
    saveCutPrompt: (jobId: string, body: CutPromptInput & { expectedRevision: number }, key: string) => request(`/pipeline-jobs/${encodeURIComponent(jobId)}/editorial-prompt`, json("PUT", body, key), promptSchema),
  };
}
function json(method: string, body: unknown, key: string): RequestInit { return { method, headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }; }
async function send<T>(fetchImplementation: typeof fetch, url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> { let response: Response; try { response = await fetchImplementation(url, init); } catch { throw new CreatorContextApiError("NETWORK_ERROR", "Не удалось связаться с API.", 0); } const payload: unknown = await response.json().catch(() => undefined); if (!response.ok) { const parsed = errorSchema.safeParse(payload); throw new CreatorContextApiError(parsed.success ? parsed.data.error.code : "API_RESPONSE_INVALID", parsed.success ? parsed.data.error.message : "Сервер вернул некорректный ответ.", response.status, parsed.success ? parsed.data.error.existingProfileId : undefined); } return schema.parse(payload); }
