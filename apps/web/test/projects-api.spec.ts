import { describe, expect, it, vi } from "vitest";

import {
  createProjectsApi,
  ProjectNetworkError,
  type UploadProgress,
} from "~/shared/api/projects";

const projectPayload = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "x",
  status: "SOURCE_READY",
  rights: { confirmedAt: "2026-09-01T00:00:00.000Z", declarationVersion: "x" },
  authorization: {
    status: "NOT_REVIEWED",
    sourceVersion: 1,
    sourceSha256: "a".repeat(64),
    basis: null,
    confirmedAt: null,
    declarationVersion: null,
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
} as const;

type FakeXhr = {
  upload: {
    onprogress:
      ((event: ProgressEvent<XMLHttpRequestEventTarget>) => void) | null;
    onload: ((event: ProgressEvent<XMLHttpRequestEventTarget>) => void) | null;
  };
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  onload: (() => void) | null;
  responseText: string;
  status: number;
  open: ReturnType<typeof vi.fn>;
  setRequestHeader: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
};

function fakeXhr(): FakeXhr {
  return {
    upload: { onprogress: null, onload: null },
    onerror: null,
    onabort: null,
    onload: null,
    responseText: JSON.stringify(projectPayload),
    status: 201,
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    send: vi.fn(),
    abort: vi.fn(),
  };
}

describe("projects API adapter", () => {
  it("uses XHR for multipart upload and reports measured progress before finalization", async () => {
    const xhr = fakeXhr();
    const api = createProjectsApi({
      apiBasePath: "/api/v1",
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
    });
    const progress: UploadProgress[] = [];
    const pending = api.createProject({
      name: "x",
      file: new File(["x"], "x.mp4", { type: "video/mp4" }),
      idempotencyKey: "attempt-0001",
      onUploadProgress: (event) => progress.push(event),
    });

    expect(xhr.open).toHaveBeenCalledWith("POST", "/api/v1/projects");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith(
      "Idempotency-Key",
      "attempt-0001",
    );
    const body = xhr.send.mock.calls[0]?.[0] as FormData;
    expect(body.get("name")).toBe("x");
    expect(body.has("rightsConfirmed")).toBe(false);
    expect(body.get("file")).toBeInstanceOf(File);

    const event = {
      lengthComputable: true,
      loaded: 5,
      total: 10,
    } as ProgressEvent<XMLHttpRequestEventTarget>;
    xhr.upload.onprogress?.(event);
    xhr.upload.onload?.({
      ...event,
      loaded: 10,
    } as ProgressEvent<XMLHttpRequestEventTarget>);
    expect(progress).toMatchObject([
      {
        uploadedBytes: 5,
        totalBytes: 10,
        percent: 50,
        transferCompleted: false,
      },
      {
        uploadedBytes: 10,
        totalBytes: 10,
        percent: 100,
        etaSeconds: 0,
        transferCompleted: true,
      },
    ]);
    xhr.onload?.();
    await expect(pending).resolves.toMatchObject({ id: projectPayload.id });
  });

  it("confirms the exact server tuple with literal true and parses the response", async () => {
    const cleared = {
      ...projectPayload,
      authorization: {
        ...projectPayload.authorization,
        status: "CLEARED",
        basis: "EXPLICIT_CONFIRMATION",
        confirmedAt: "2026-09-09T12:00:00.000Z",
        declarationVersion: "source-rights-v1",
      },
    } as const;
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(cleared), { status: 200 }),
      );
    const api = createProjectsApi({
      apiBasePath: "/api/v1",
      fetchImplementation,
      xhrFactory: () => fakeXhr() as unknown as XMLHttpRequest,
    });
    await expect(
      api.confirmSourceAuthorization?.(projectPayload.id, {
        sourceVersion: 1,
        sourceSha256: "a".repeat(64),
        rightsConfirmed: true,
        declarationVersion: "source-rights-v1",
      }),
    ).resolves.toMatchObject({ authorization: { status: "CLEARED" } });
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/api/v1/projects/${projectPayload.id}/source/authorization`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          sourceVersion: 1,
          sourceSha256: "a".repeat(64),
          rightsConfirmed: true,
          declarationVersion: "source-rights-v1",
        }),
      }),
    );
  });

  it("reports an indeterminate transfer and turns an XHR transport failure into a safe error", async () => {
    const xhr = fakeXhr();
    const api = createProjectsApi({
      apiBasePath: "/api/v1",
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
    });
    const progress: UploadProgress[] = [];
    const pending = api.createProject({
      name: "x",
      file: new File(["x"], "x.mp4", { type: "video/mp4" }),
      idempotencyKey: "attempt-0001",
      onUploadProgress: (event) => progress.push(event),
    });
    xhr.upload.onprogress?.({
      lengthComputable: false,
      loaded: 5,
      total: 0,
    } as ProgressEvent<XMLHttpRequestEventTarget>);
    expect(progress[0]).toMatchObject({
      uploadedBytes: 5,
      totalBytes: null,
      percent: null,
    });
    xhr.onerror?.();
    await expect(pending).rejects.toBeInstanceOf(ProjectNetworkError);
  });
});
