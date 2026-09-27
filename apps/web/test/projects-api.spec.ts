import { describe, expect, it, vi } from "vitest";

import { createProjectsApi, listAllProjects } from "~/shared/api/projects";

const readyProject = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "x",
  status: "SOURCE_READY",
  rights: {
    confirmedAt: "2026-09-01T00:00:00.000Z",
    declarationVersion: "x",
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  source: {
    id: "00000000-0000-4000-8000-000000000002",
    status: "READY",
    sourceVersion: 1,
    addedAt: "2026-09-01T00:00:00.000Z",
    originalFilename: "x.mp4",
    contentType: "video/mp4",
    sizeBytes: "1",
    sha256: "a".repeat(64),
    authorization: {
      sourceVersion: 1,
      status: "CLEARED",
      usable: true,
      basis: "LEGACY_ATTESTATION",
      declarationVersion: "upload-rights-v1",
      decidedAt: "2026-09-01T00:00:00.000Z",
      revision: 1,
    },
  },
  cutJobCounts: { total: 0, ready: 0, failed: 0 },
  artifact: {
    id: "00000000-0000-4000-8000-000000000003",
    role: "SOURCE",
    status: "READY",
    sizeBytes: "1",
    sha256: "a".repeat(64),
    contentType: "video/mp4",
    lineageSourceId: "00000000-0000-4000-8000-000000000002",
    lineageSourceVersion: 1,
    recipeVersion: "x",
  },
};

describe("projects API adapter", () => {
  it("sends the exact relative endpoint, idempotency header, and multipart fields", async () => {
    const request = {
      status: 201,
      responseText: JSON.stringify(readyProject),
      upload: {},
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      onerror: null,
      onabort: null,
      onload: null,
    } as unknown as XMLHttpRequest;
    const api = createProjectsApi({
      apiBasePath: "/api/v1",
      xmlHttpRequestFactory: () => request,
    });
    const progress: Array<{ loaded: number; total: number }> = [];
    const created = api.createProject({
      name: "x",
      file: new File(["x"], "x.mp4", { type: "video/mp4" }),
      idempotencyKey: "attempt-0001",
      onUploadProgress: (event) => progress.push(event),
    });
    expect(request.open).toHaveBeenCalledWith("POST", "/api/v1/projects");
    expect(request.setRequestHeader).toHaveBeenCalledWith(
      "Idempotency-Key",
      "attempt-0001",
    );
    const body = vi.mocked(request.send).mock.calls[0]?.[0] as FormData;
    expect(body.get("name")).toBe("x");
    expect(body.has("rightsConfirmed")).toBe(false);
    expect(body.get("file")).toBeInstanceOf(File);
    request.upload.onprogress?.({
      lengthComputable: true,
      loaded: 25,
      total: 100,
    } as ProgressEvent);
    request.onload?.(new Event("load"));
    await created;
    expect(progress).toEqual([{ loaded: 25, total: 100 }]);
  });

  it("sends an explicit versioned source authorization decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => readyProject,
    });
    const api = createProjectsApi({
      apiBasePath: "/api/v1",
      fetchImplementation: fetchMock,
    });

    await api.attestSourceAuthorization?.({
      projectId: readyProject.id,
      sourceVersion: 3,
      expectedRevision: 7,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/projects/${readyProject.id}/source-authorization`,
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceVersion: 3,
          expectedRevision: 7,
          declarationVersion: "source-authorization-v1",
          attested: true,
        }),
      }),
    );
  });

  it("loads project selectors through contract-sized cursor pages", async () => {
    const secondProject = {
      ...readyProject,
      id: "00000000-0000-4000-8000-000000000011",
      source: {
        ...readyProject.source,
        id: "00000000-0000-4000-8000-000000000012",
      },
      artifact: {
        ...readyProject.artifact,
        id: "00000000-0000-4000-8000-000000000013",
        lineageSourceId: "00000000-0000-4000-8000-000000000012",
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [readyProject], nextCursor: "next-page" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [secondProject], nextCursor: null }),
      });
    const api = createProjectsApi({
      apiBasePath: "/api/v1",
      fetchImplementation: fetchMock,
    });

    await expect(
      listAllProjects(api, { status: "SOURCE_READY" }),
    ).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/projects?status=SOURCE_READY&limit=50",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/projects?status=SOURCE_READY&cursor=next-page&limit=50",
      expect.any(Object),
    );
  });
});
