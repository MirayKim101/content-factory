import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";

import {
  clearActiveAttempt,
  saveActiveAttempt,
} from "~/features/upload-source/model/active-attempt-storage";
import SourceUploadWidget from "~/widgets/source-upload/ui/source-upload-widget.vue";

const activeAttemptKey = "attempt-recovery-0001";
const recoveredFile = () =>
  new File(["video"], "recovered.mp4", {
    type: "video/mp4",
    lastModified: 1,
  });
const readyProject = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Восстановленный ролик",
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
    originalFilename: "recovered.mp4",
    contentType: "video/mp4",
    sizeBytes: "5",
    sha256: "a".repeat(64),
    authorization: {
      sourceVersion: 1,
      status: "NOT_REVIEWED",
      revision: 1,
    },
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
};

class SuccessfulUploadRequest {
  static instances: SuccessfulUploadRequest[] = [];

  status = 201;
  responseText = JSON.stringify(readyProject);
  upload: XMLHttpRequestUpload = {} as XMLHttpRequestUpload;
  onerror: XMLHttpRequestEventTarget["onerror"] = null;
  onabort: XMLHttpRequestEventTarget["onabort"] = null;
  onload: XMLHttpRequestEventTarget["onload"] = null;
  readonly open = vi.fn();
  readonly setRequestHeader = vi.fn();
  readonly send = vi.fn(() => {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 5,
      total: 5,
    } as ProgressEvent);
    this.onload?.(new Event("load"));
  });
  readonly abort = vi.fn();

  constructor() {
    SuccessfulUploadRequest.instances.push(this);
  }
}

function mountWidget() {
  return mount(SourceUploadWidget, {
    global: {
      plugins: [
        [PrimeVue, { unstyled: true }],
        [VueQueryPlugin, { queryClient: new QueryClient() }],
      ],
    },
  });
}

async function selectFile(
  input: {
    element: HTMLInputElement;
    trigger(event: string): Promise<void>;
  },
  file: File,
): Promise<void> {
  Object.defineProperty(input.element, "files", {
    configurable: true,
    value: { 0: file, length: 1, item: () => file },
  });
  await input.trigger("change");
}

describe("SourceUploadWidget runtime", () => {
  beforeEach(() => {
    clearActiveAttempt();
    SuccessfulUploadRequest.instances = [];
    vi.stubGlobal("useRuntimeConfig", () => ({
      public: { apiBasePath: "/api/v1" },
    }));
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("XMLHttpRequest", SuccessfulUploadRequest);
  });
  afterEach(() => {
    clearActiveAttempt();
    vi.unstubAllGlobals();
  });
  it("mounts with Vue Query and renders the accessible upload form", () => {
    const wrapper = mountWidget();
    expect(wrapper.get("form").exists()).toBe(true);
    expect(wrapper.get('label[for="project-name"]').text()).toBe(
      "Название проекта",
    );
    expect(wrapper.get('input[type="file"]').attributes("accept")).toContain(
      "mp4",
    );
    expect(
      wrapper.find('[aria-describedby="rights-confirmed-error"]').exists(),
    ).toBe(false);
    expect(wrapper.get('[aria-live="polite"]').exists()).toBe(true);
  });

  it("keeps a pre-response recovery visible until the matching file is explicitly retried with its original key", async () => {
    const file = recoveredFile();
    saveActiveAttempt({
      idempotencyKey: activeAttemptKey,
      name: "Восстановленный ролик",
      fingerprint: {
        size: file.size,
        lastModified: file.lastModified,
        type: file.type,
      },
      status: "SENDING",
    });
    const wrapper = mountWidget();
    await flushPromises();

    expect(wrapper.text()).not.toContain("Продолжить проверку");
    expect(wrapper.text()).toContain("Выбери тот же MP4 ещё раз");
    const input = wrapper.get<HTMLInputElement>('input[type="file"]');
    await selectFile(
      input,
      new File(["different video"], "other.mp4", {
        type: "video/mp4",
        lastModified: file.lastModified,
      }),
    );
    expect(wrapper.text()).toContain("Исходная попытка сохранена");
    expect(wrapper.text()).toContain("Сбросить и начать новую попытку");
    expect(SuccessfulUploadRequest.instances).toHaveLength(0);

    await selectFile(input, file);
    expect(wrapper.text()).toContain("Файл подтверждён");
    expect(SuccessfulUploadRequest.instances).toHaveLength(0);

    const retry = wrapper
      .findAll("button")
      .find((button) =>
        button.text().includes("Повторить загрузку с тем же ключом"),
      );
    expect(retry).toBeDefined();
    await retry?.trigger("click");
    await flushPromises();

    expect(SuccessfulUploadRequest.instances).toHaveLength(1);
    expect(
      SuccessfulUploadRequest.instances[0]?.setRequestHeader,
    ).toHaveBeenCalledWith("Idempotency-Key", activeAttemptKey);
  });

  it("continues a known project with GET only", async () => {
    const file = recoveredFile();
    saveActiveAttempt({
      idempotencyKey: activeAttemptKey,
      projectId: readyProject.id,
      name: "Восстановленный ролик",
      fingerprint: {
        size: file.size,
        lastModified: file.lastModified,
        type: file.type,
      },
      status: "SOURCE_PENDING",
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(readyProject), { status: 200 }),
    );
    const wrapper = mountWidget();
    await flushPromises();

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Продолжить проверку"))
      ?.trigger("click");
    await flushPromises();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toContain(`/projects/${readyProject.id}`);
    expect(init).not.toMatchObject({ method: "POST" });
  });
});
