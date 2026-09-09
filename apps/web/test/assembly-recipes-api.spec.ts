import { describe, expect, it } from "vitest";

import { createAssemblyRecipesApi } from "~/shared/api/assembly-recipes";

const recipe = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  pipelineJobId: "00000000-0000-4000-8000-000000000003",
  cutResultArtifact: {
    id: "00000000-0000-4000-8000-000000000004",
    durationMs: 60_000,
    sha256: "a".repeat(64),
    sizeBytes: "1",
    sourceId: "00000000-0000-4000-8000-000000000005",
    sourceVersion: 1,
    recipeVersion: "cut",
  },
  revision: {
    id: "00000000-0000-4000-8000-000000000006",
    revision: 1,
    schemaVersion: "horizontal-assembly-v1",
    configurationFingerprint: "a".repeat(64),
    configuration: {
      introAssetId: null,
      outroAssetId: null,
      advertisement: null,
      banners: [],
      cta: null,
      audioProfileVersion: "youtube-stereo-v1",
      encodingProfileVersion: "youtube-h264-v1",
    },
    assets: { intro: null, outro: null, advertisement: null, banners: [] },
    createdAt: "2026-09-06T00:00:00.000Z",
  },
  validation: { valid: true },
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};

describe("assembly recipes API", () => {
  it("treats a missing current recipe as an empty durable draft", async () => {
    const api = createAssemblyRecipesApi(
      "/api/v1",
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "ASSEMBLY_RECIPE_NOT_FOUND", message: "none" },
          }),
          { status: 404 },
        ),
    );
    await expect(api.get(recipe.pipelineJobId)).resolves.toBeUndefined();
  });

  it("does not hide an unrelated 404 as an empty recipe", async () => {
    const api = createAssemblyRecipesApi(
      "/api/v1",
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "PIPELINE_JOB_NOT_FOUND", message: "none" },
          }),
          { status: 404 },
        ),
    );
    await expect(api.get(recipe.pipelineJobId)).rejects.toMatchObject({
      code: "PIPELINE_JOB_NOT_FOUND",
      status: 404,
    });
  });

  it("sends PUT with the exact idempotency key and validates response", async () => {
    let request: RequestInit | undefined;
    const api = createAssemblyRecipesApi("/api/v1", async (_url, init) => {
      request = init;
      return new Response(JSON.stringify(recipe), { status: 200 });
    });
    await expect(
      api.save(
        recipe.pipelineJobId,
        {
          expectedRevision: 0,
          introAssetId: null,
          outroAssetId: null,
          advertisement: null,
          banners: [],
          cta: null,
          audioProfileVersion: "youtube-stereo-v1",
          encodingProfileVersion: "youtube-h264-v1",
        },
        "stable-key",
      ),
    ).resolves.toMatchObject({ id: recipe.id });
    expect(request?.method).toBe("PUT");
    expect(
      (request?.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe("stable-key");
  });
});
