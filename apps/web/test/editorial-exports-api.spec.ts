import { describe, expect, it } from "vitest";

import {
  createEditorialExportsApi,
  EditorialExportsApiError,
} from "~/shared/api/editorial-exports";

const ids = {
  approval: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000002",
  export: "00000000-0000-4000-8000-000000000003",
  source: "00000000-0000-4000-8000-000000000004",
  cut: "00000000-0000-4000-8000-000000000005",
  revision: "00000000-0000-4000-8000-000000000006",
  recipe: "00000000-0000-4000-8000-000000000007",
  result: "00000000-0000-4000-8000-000000000008",
  job: "00000000-0000-4000-8000-000000000009",
};

function payload(state: "QUEUED" | "PROCESSING" | "READY" = "QUEUED") {
  return {
    id: ids.export,
    approvalId: ids.approval,
    approvalCurrent: true,
    approvalCandidateFingerprint: "a".repeat(64),
    projectId: ids.project,
    sourceId: ids.source,
    sourceVersion: 1,
    cutPipelineJobId: ids.cut,
    editorialPackageRevisionId: ids.revision,
    recipeRevisionId: ids.recipe,
    assemblyRenderResultId: ids.result,
    exportContractVersion: "editorial-export-zip-v1",
    createdAt: "2026-09-06T00:00:00.000Z",
    job: {
      id: ids.job,
      state,
      attempt: 0,
      retryBudget: 2,
      revision: 1,
      admissionReason: null,
      nextAttemptAt: null,
      failure: null,
      progress:
        state === "PROCESSING"
          ? {
              attemptNumber: 1,
              basisPoints: 4_250,
              phase: "WRITE_ARCHIVE",
              schemaVersion: "editorial-export-progress-v1",
              updatedAt: "2026-09-06T00:00:00.000Z",
            }
          : null,
    },
    result:
      state === "READY"
        ? {
            completedAt: "2026-09-06T00:01:00.000Z",
            downloadUrl: "/api/v1/editorial-exports/x/content",
            filename: "package.zip",
            manifest: {},
            sha256: "b".repeat(64),
            sizeBytes: "100",
          }
        : null,
  };
}

describe("editorial exports API", () => {
  it("creates an exact export with the durable idempotency key", async () => {
    const fetchImplementation = async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/api/v1/editorial-approvals/${ids.approval}/exports`);
      expect(init).toMatchObject({ method: "POST" });
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
        "same-key",
      );
      return new Response(JSON.stringify(payload()), { status: 202 });
    };
    const api = createEditorialExportsApi("/api/v1", fetchImplementation);
    await expect(api.create(ids.approval, "same-key")).resolves.toMatchObject({
      id: ids.export,
      job: { state: "QUEUED" },
    });
  });

  it.each([404, 409, 503])(
    "keeps export HTTP %i explicit and never fabricates a package",
    async (status) => {
      const api = createEditorialExportsApi(
        "/api/v1",
        async () =>
          new Response(
            JSON.stringify({
              error: { code: `HTTP_${status}`, message: "blocked" },
            }),
            { status },
          ),
      );
      await expect(api.create(ids.approval, "same-key")).rejects.toEqual(
        expect.objectContaining<Partial<EditorialExportsApiError>>({
          code: `HTTP_${status}`,
          status,
        }),
      );
    },
  );

  it("restores a real processing phase from the project list", async () => {
    const api = createEditorialExportsApi(
      "/api/v1",
      async () =>
        new Response(
          JSON.stringify({ items: [payload("PROCESSING")], nextCursor: null }),
        ),
    );
    await expect(api.list(ids.project)).resolves.toMatchObject([
      { job: { progress: { basisPoints: 4_250, phase: "WRITE_ARCHIVE" } } },
    ]);
  });

  it("fails closed when a project list contains an export from another project", async () => {
    const api = createEditorialExportsApi(
      "/api/v1",
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                ...payload(),
                projectId: "00000000-0000-4000-8000-000000000099",
              },
            ],
            nextCursor: null,
          }),
        ),
    );
    await expect(api.list(ids.project)).rejects.toEqual(
      expect.objectContaining<Partial<EditorialExportsApiError>>({
        code: "PROJECT_IDENTITY_MISMATCH",
        status: 0,
      }),
    );
  });
});
