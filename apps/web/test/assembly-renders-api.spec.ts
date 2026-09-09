import { describe, expect, it } from "vitest";

import { createAssemblyRendersApi } from "~/shared/api/assembly-renders";

const render = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  sourceId: "00000000-0000-4000-8000-000000000003",
  sourceVersion: 1,
  cutPipelineJobId: "00000000-0000-4000-8000-000000000004",
  cutResultArtifactId: "00000000-0000-4000-8000-000000000005",
  assemblyRecipeId: "00000000-0000-4000-8000-000000000006",
  recipeRevisionId: "00000000-0000-4000-8000-000000000007",
  recipeRevision: 2,
  configurationFingerprint: "a".repeat(64),
  expectedDurationMs: 62_000,
  renderContractVersion: "horizontal-render-v1" as const,
  audioProfileVersion: "youtube-stereo-v1" as const,
  encodingProfileVersion: "youtube-h264-v1" as const,
  inputs: [
    {
      id: "00000000-0000-4000-8000-000000000008",
      role: "CUT" as const,
      sha256: "b".repeat(64),
      sizeBytes: "123",
      durationMs: 60_000,
      revision: null,
    },
  ],
  job: {
    id: "00000000-0000-4000-8000-000000000009",
    state: "PROCESSING" as const,
    attempt: 1,
    retryBudget: 3,
    revision: 1,
    admissionReason: null,
    nextAttemptAt: null,
    failure: null,
    progress: {
      attemptNumber: 1,
      basisPoints: 4_200,
      phase: "ENCODE" as const,
      schemaVersion: "assembly-progress-v1" as const,
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
  },
  result: null,
  createdAt: "2026-09-06T00:00:00.000Z",
};

describe("assembly renders API", () => {
  it("posts the exact saved recipe revision with the durable idempotency key", async () => {
    let init: RequestInit | undefined;
    const api = createAssemblyRendersApi("/api/v1", async (_url, value) => {
      init = value;
      return new Response(JSON.stringify(render), { status: 202 });
    });
    await expect(
      api.create(
        render.cutPipelineJobId,
        render.recipeRevision,
        "stable-render-key",
      ),
    ).resolves.toMatchObject({
      id: render.id,
      job: { progress: { basisPoints: 4_200 } },
    });
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "stable-render-key",
    );
    expect(init?.body).toBe(JSON.stringify({ recipeRevision: 2 }));
  });

  it("loads every project page and removes a duplicate render returned on a cursor boundary", async () => {
    let calls = 0;
    const api = createAssemblyRendersApi("/api/v1", async () => {
      calls += 1;
      return new Response(
        JSON.stringify(
          calls === 1
            ? { items: [render], nextCursor: "next" }
            : { items: [render], nextCursor: null },
        ),
        { status: 200 },
      );
    });
    await expect(api.list(render.projectId)).resolves.toHaveLength(1);
  });

  it("keeps server failures explicit instead of silently treating a failed render as empty", async () => {
    const api = createAssemblyRendersApi(
      "/api/v1",
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "ASSEMBLY_RENDER_NOT_FOUND", message: "none" },
          }),
          { status: 404 },
        ),
    );
    await expect(api.get(render.id)).rejects.toMatchObject({
      code: "ASSEMBLY_RENDER_NOT_FOUND",
      status: 404,
    });
  });
});
