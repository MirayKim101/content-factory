import { describe, expect, it, vi } from "vitest";
import { createApp, effectScope, nextTick } from "vue";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";

import type { Project } from "~/shared/api/generated/project";
import {
  ProjectApiError,
  ProjectNetworkError,
  type ProjectsApi,
} from "~/shared/api/projects";
import { validateSourceUploadForm } from "~/features/upload-source/model/source-upload-form";
import { useSourceUpload } from "~/features/upload-source/model/use-source-upload";

const sourceFile = () =>
  new File(["video"], "source.mp4", { type: "video/mp4" });
const project = (name = "Первый ролик"): Project => ({
  id: "00000000-0000-4000-8000-000000000001",
  name,
  status: "SOURCE_READY",
  rights: {
    confirmedAt: "2026-09-01T12:00:00.000Z",
    declarationVersion: "upload-rights-v1",
  },
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
  source: {
    id: "00000000-0000-4000-8000-000000000002",
    status: "READY",
    sourceVersion: 1,
    originalFilename: "source.mp4",
    contentType: "video/mp4",
    sizeBytes: "5",
    sha256: "a".repeat(64),
  },
  artifact: {
    id: "00000000-0000-4000-8000-000000000003",
    role: "SOURCE",
    status: "READY",
    sizeBytes: "5",
    sha256: "a".repeat(64),
    contentType: "video/mp4",
    lineageSourceId: "00000000-0000-4000-8000-000000000002",
    lineageSourceVersion: 1,
    recipeVersion: "source-ingest-v1",
  },
});

function validUpload(api: ProjectsApi) {
  const app = createApp({});
  app.use(VueQueryPlugin, { queryClient: new QueryClient() });
  const scope = effectScope();
  const upload = app.runWithContext(() =>
    scope.run(() => useSourceUpload(api))!,
  );
  upload.updateDraft({
    name: "Первый ролик",
    rightsConfirmed: true,
    file: sourceFile(),
  });
  return upload;
}

describe("source upload validation", () => {
  it("rejects empty/too long names, missing rights, and a non-MP4 file", () => {
    const result = validateSourceUploadForm({
      name: " ",
      rightsConfirmed: false,
      file: new File(["x"], "source.mov", { type: "video/quicktime" }),
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.errors).toMatchObject({
        name: expect.any(String),
        rightsConfirmed: expect.any(String),
        file: expect.any(String),
      });
    const longName = validateSourceUploadForm({
      name: "a".repeat(201),
      rightsConfirmed: true,
      file: sourceFile(),
    });
    expect(longName.success).toBe(false);
  });
});

describe("source upload workflow", () => {
  it("succeeds and shows the safe project result", async () => {
    const api: ProjectsApi = {
      createProject: vi.fn().mockResolvedValue(project()),
    };
    const upload = validUpload(api);
    await upload.submit();
    expect(upload.state.value).toBe("success");
    expect(upload.result.value?.name).toBe("Первый ролик");
  });

  it("does not send twice while the first request is pending", async () => {
    let finish: ((value: Project) => void) | undefined;
    const api: ProjectsApi = {
      createProject: vi.fn(
        () =>
          new Promise<Project>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const upload = validUpload(api);
    const first = upload.submit();
    const second = upload.submit();
    await Promise.resolve();
    expect(api.createProject).toHaveBeenCalledTimes(1);
    finish?.(project());
    await Promise.all([first, second]);
  });

  it("uses the same idempotency key when explicitly retrying after an unknown network outcome", async () => {
    const api: ProjectsApi = {
      createProject: vi
        .fn()
        .mockRejectedValueOnce(new ProjectNetworkError())
        .mockResolvedValueOnce(project()),
    };
    const upload = validUpload(api);
    await upload.submit();
    expect(upload.requestError.value).toContain("не знаем");
    await upload.submit();
    const calls = vi.mocked(api.createProject).mock.calls;
    expect(calls[0]?.[0].idempotencyKey).toBe(calls[1]?.[0].idempotencyKey);
  });

  it("creates a new key after form changes and ignores the stale old response", async () => {
    let resolveOld: ((value: Project) => void) | undefined;
    const api: ProjectsApi = {
      createProject: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Project>((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockResolvedValueOnce(project("Новый ролик")),
    };
    const upload = validUpload(api);
    const oldRequest = upload.submit();
    upload.updateDraft({ name: "Новый ролик" });
    const newRequest = upload.submit();
    await newRequest;
    resolveOld?.(project("Старый ролик"));
    await oldRequest;
    const calls = vi.mocked(api.createProject).mock.calls;
    expect(calls[0]?.[0].idempotencyKey).not.toBe(calls[1]?.[0].idempotencyKey);
    expect(upload.result.value?.name).toBe("Новый ролик");
  });

  it("shows a controlled server error", async () => {
    const api: ProjectsApi = {
      createProject: vi
        .fn()
        .mockRejectedValue(
          new ProjectApiError("Файл не является MP4.", "INVALID_MP4", 415),
        ),
    };
    const upload = validUpload(api);
    await upload.submit();
    expect(upload.state.value).toBe("error");
    expect(upload.requestError.value).toBe("Файл не является MP4.");
  });

  it("recovers a known pending project with GET only", async () => {
    vi.useFakeTimers();
    const api: ProjectsApi = {
      createProject: vi.fn(),
      getProject: vi.fn().mockResolvedValue(project()),
    };
    const upload = validUpload(api);
    upload.recoverAttempt({
      idempotencyKey: "attempt-0001",
      projectId: "00000000-0000-4000-8000-000000000001",
      name: "Первый ролик",
      fingerprint: { size: 5, lastModified: 1, type: "video/mp4" },
      status: "SOURCE_PENDING",
    });
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("refuses a mismatched recovered file and preserves the original retry key", () => {
    const api: ProjectsApi = { createProject: vi.fn() };
    const upload = validUpload(api);
    expect(
      upload.prepareRecoveredRetry(
        {
          idempotencyKey: "attempt-0001",
          name: "Первый ролик",
          fingerprint: { size: 10, lastModified: 1, type: "video/mp4" },
          status: "SENDING",
        },
        sourceFile(),
      ),
    ).toBe(false);
  });

  it("retries an exactly matched recovered SENDING file with the original key", async () => {
    const api: ProjectsApi = {
      createProject: vi.fn().mockResolvedValue(project()),
    };
    const upload = validUpload(api);
    const file = sourceFile();
    expect(
      upload.prepareRecoveredRetry(
        {
          idempotencyKey: "attempt-0001",
          name: "Первый ролик",
          fingerprint: {
            size: file.size,
            lastModified: file.lastModified,
            type: file.type,
          },
          status: "SENDING",
        },
        file,
      ),
    ).toBe(true);
    await upload.submit();
    expect(vi.mocked(api.createProject).mock.calls[0]?.[0].idempotencyKey).toBe(
      "attempt-0001",
    );
  });

  it("clears a terminal failed key so a new attempt receives a different key", async () => {
    const failed = { ...project(), status: "FAILED_FINAL" as const };
    const api: ProjectsApi = {
      createProject: vi
        .fn()
        .mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(project()),
    };
    const upload = validUpload(api);
    await upload.submit();
    upload.startNewAttempt();
    await upload.submit();
    const calls = vi.mocked(api.createProject).mock.calls;
    expect(calls[0]?.[0].idempotencyKey).not.toBe(calls[1]?.[0].idempotencyKey);
  });

  it("shows a poll GET error and retryPoll does not create another POST", async () => {
    vi.useFakeTimers();
    const api: ProjectsApi = {
      createProject: vi.fn(),
      getProject: vi
        .fn()
        .mockRejectedValueOnce(new ProjectNetworkError())
        .mockResolvedValueOnce(project()),
    };
    const upload = validUpload(api);
    upload.recoverAttempt({
      idempotencyKey: "attempt-0001",
      projectId: "00000000-0000-4000-8000-000000000001",
      name: "Первый ролик",
      fingerprint: { size: 5, lastModified: 1, type: "video/mp4" },
      status: "SOURCE_PENDING",
    });
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(upload.pollError.value).toContain("Сеть");
    upload.retryPoll();
    await Promise.resolve();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.getProject).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("ignores a stale create error after a newer attempt succeeds", async () => {
    let rejectOld: ((reason?: unknown) => void) | undefined;
    const api: ProjectsApi = {
      createProject: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Project>((_, reject) => {
              rejectOld = reject;
            }),
        )
        .mockResolvedValueOnce(project("Новый ролик")),
    };
    const upload = validUpload(api);
    const oldRequest = upload.submit();
    upload.updateDraft({ name: "Новый ролик" });
    await upload.submit();
    rejectOld?.(new ProjectNetworkError());
    await oldRequest;
    expect(upload.result.value?.name).toBe("Новый ролик");
    expect(upload.requestError.value).toBeNull();
  });

  it("ignores a stale terminal poll result after a newer local attempt", async () => {
    let resolvePoll: ((value: Project) => void) | undefined;
    const api: ProjectsApi = {
      createProject: vi.fn().mockResolvedValue(project("Новый ролик")),
      getProject: vi.fn(
        () =>
          new Promise<Project>((resolve) => {
            resolvePoll = resolve;
          }),
      ),
    };
    const upload = validUpload(api);
    upload.recoverAttempt({
      idempotencyKey: "attempt-0001",
      projectId: "00000000-0000-4000-8000-000000000001",
      name: "Первый ролик",
      fingerprint: { size: 5, lastModified: 1, type: "video/mp4" },
      status: "SOURCE_PENDING",
    });
    await nextTick();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    upload.updateDraft({ name: "Новый ролик" });
    await upload.submit();
    resolvePoll?.({ ...project(), status: "FAILED_FINAL" });
    await Promise.resolve();
    expect(upload.result.value?.name).toBe("Новый ролик");
    expect(upload.requestError.value).toBeNull();
  });

  it("ignores a stale poll error after a newer local attempt", async () => {
    let rejectPoll: ((reason?: unknown) => void) | undefined;
    const api: ProjectsApi = {
      createProject: vi.fn().mockResolvedValue(project("Новый ролик")),
      getProject: vi.fn(
        () =>
          new Promise<Project>((_, reject) => {
            rejectPoll = reject;
          }),
      ),
    };
    const upload = validUpload(api);
    upload.recoverAttempt({
      idempotencyKey: "attempt-0001",
      projectId: "00000000-0000-4000-8000-000000000001",
      name: "Первый ролик",
      fingerprint: { size: 5, lastModified: 1, type: "video/mp4" },
      status: "SOURCE_PENDING",
    });
    await nextTick();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    upload.updateDraft({ name: "Новый ролик" });
    await upload.submit();
    rejectPoll?.(new ProjectNetworkError());
    await Promise.resolve();
    expect(upload.result.value?.name).toBe("Новый ролик");
    expect(upload.requestError.value).toBeNull();
  });
});
