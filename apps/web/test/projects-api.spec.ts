import { describe, expect, it, vi } from "vitest";

import { createProjectsApi } from "~/shared/api/projects";

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
    originalFilename: "x.mp4",
    contentType: "video/mp4",
    sizeBytes: "1",
    sha256: "a".repeat(64),
  },
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
    expect(body.get("rightsConfirmed")).toBe("true");
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
});
