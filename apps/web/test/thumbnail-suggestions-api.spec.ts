import { describe, expect, it } from "vitest";

import { createThumbnailSuggestionsApi } from "../app/shared/api/thumbnail-suggestions";

const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const intentId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";
const response = { id: intentId, projectId, cutPipelineJobId: jobId, state: "READY", contractVersion: "editorial-thumbnail-v1", adapterVersion: "local-no-likeness-png-v1", promptBasisVersion: "local-abstract-thumbnail-prompt-v1", candidate: { id: candidateId, contentType: "image/png", sizeBytes: "100", sha256: "a".repeat(64), width: 1280, height: 720, likeness: "NONE", safetyDecision: {}, directCostMicrousd: "0", costBasisVersion: "local-direct-provider-cost-zero-v1" }, failure: null, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" };

describe("thumbnail suggestions api", () => {
  it("creates a scoped durable request with idempotency", async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      expect(String(input)).toContain(`/projects/${projectId}/pipeline-jobs/${jobId}/image-suggestions`);
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("create-key");
      expect(JSON.parse(String(init?.body))).toEqual({ sourceContextRevisionId: projectId, cutPromptRevisionId: jobId });
      return new Response(JSON.stringify({ ...response, state: "QUEUED", candidate: null }), { status: 202, headers: { "Content-Type": "application/json" } });
    };
    await expect(createThumbnailSuggestionsApi("/api/v1", fetchMock).create(projectId, jobId, "create-key", { sourceContextRevisionId: projectId, cutPromptRevisionId: jobId })).resolves.toMatchObject({ id: intentId, state: "QUEUED" });
  });

  it("applies the exact revision with idempotency", async () => {
    const fetchMock: typeof fetch = async (_input, init) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("apply-key");
      expect(JSON.parse(String(init?.body))).toEqual({ expectedEditorialRevision: 2 });
      return new Response(JSON.stringify({ packageId: projectId, packageRevisionId: jobId, revision: 3, thumbnailAssetId: candidateId, thumbnailMode: "AI_ASSISTED" }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await expect(createThumbnailSuggestionsApi("/api/v1", fetchMock).apply(projectId, jobId, intentId, "apply-key", 2)).resolves.toMatchObject({ revision: 3, thumbnailMode: "AI_ASSISTED" });
  });

  it("builds a private candidate content URL without exposing an object key", () => {
    const url = createThumbnailSuggestionsApi("/api/v1").contentUrl(projectId, jobId, intentId, candidateId);
    expect(url).toContain(`/candidates/${candidateId}/content`); expect(url).not.toContain("ai-content/");
  });
});
