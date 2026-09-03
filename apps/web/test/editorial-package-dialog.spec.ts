import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  projectA: "00000000-0000-4000-8000-000000000101",
  projectB: "00000000-0000-4000-8000-000000000102",
  jobA: "00000000-0000-4000-8000-000000000201",
  jobB: "00000000-0000-4000-8000-000000000202",
  template: "00000000-0000-4000-8000-000000000301",
};
const mocks = vi.hoisted(() => ({
  listPackages: vi.fn(),
  listTemplates: vi.fn(),
  listThumbnails: vi.fn(),
  savePackage: vi.fn(),
  createTemplate: vi.fn(),
  uploadThumbnail: vi.fn(),
  EditorialApiError: class EditorialApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("~/shared/api/editorial-content", () => ({
  EditorialApiError: mocks.EditorialApiError,
  createEditorialContentApi: () => ({
    listProjectPackages: mocks.listPackages,
    listTemplates: mocks.listTemplates,
    listThumbnails: mocks.listThumbnails,
    savePackage: mocks.savePackage,
    createTemplate: mocks.createTemplate,
    uploadThumbnail: mocks.uploadThumbnail,
    thumbnailContentUrl: () => "/private-thumbnail",
  }),
}));

import EditorialPackageDialog from "~/features/edit-editorial-package/ui/editorial-package-dialog.vue";

function pack(projectId: string, jobId: string, title: string, revision = 1) {
  return {
    id: "00000000-0000-4000-8000-000000000401",
    projectId,
    pipelineJobId: jobId,
    cutResultArtifact: {
      id: "00000000-0000-4000-8000-000000000501",
      sha256: "a".repeat(64),
      sizeBytes: "1",
      sourceId: "00000000-0000-4000-8000-000000000601",
      sourceVersion: 1,
      recipeVersion: "cut",
    },
    revision: {
      id: "00000000-0000-4000-8000-000000000701",
      revision,
      processingTemplateRevision: template(),
      title,
      description: `${title} description`,
      tags: ["one", "two"],
      thumbnail: null,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    validation: { complete: false, missingFields: ["THUMBNAIL"] },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}
function template() {
  return {
    id: ids.template,
    templateId: "00000000-0000-4000-8000-000000000302",
    revision: 1,
    name: "Manual",
    configurationVersion: "manual-editorial-v1" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}
function mountDialog(queryClient?: QueryClient) {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  return mount(EditorialPackageDialog, {
    props: {
      visible: true,
      projectId: ids.projectA,
      jobId: ids.jobA,
      filename: "cut.mp4",
    },
    global: {
      plugins: [
        [
          VueQueryPlugin,
          {
            queryClient:
              queryClient ??
              new QueryClient({
                defaultOptions: { queries: { retry: false } },
              }),
          },
        ],
      ],
      stubs: {
        Dialog: { template: "<section><slot /></section>" },
        InputText: {
          props: ["modelValue"],
          emits: ["update:modelValue"],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        Textarea: {
          props: ["modelValue"],
          emits: ["update:modelValue"],
          template:
            '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        Select: {
          props: ["modelValue", "options"],
          emits: ["update:modelValue"],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in options" :value="item.id">{{ item.name || item.originalFilename }}</option></select>',
        },
        Button: {
          props: ["disabled", "label"],
          template: '<button :disabled="disabled"><slot />{{ label }}</button>',
        },
      },
    },
  });
}

describe("EditorialPackageDialog", () => {
  beforeEach(() => {
    mocks.listPackages.mockReset();
    mocks.listTemplates.mockReset();
    mocks.listThumbnails.mockReset();
    mocks.savePackage.mockReset();
    mocks.createTemplate.mockReset();
    mocks.uploadThumbnail.mockReset();
    mocks.listTemplates.mockResolvedValue([template()]);
    mocks.listThumbnails.mockResolvedValue([]);
    mocks.listPackages.mockImplementation((projectId: string) =>
      Promise.resolve([
        pack(
          projectId,
          projectId === ids.projectA ? ids.jobA : ids.jobB,
          projectId === ids.projectA ? "A title" : "B title",
        ),
      ]),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads saved revisions independently when switching project and job", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("A title");
    await wrapper.setProps({ projectId: ids.projectB, jobId: ids.jobB });
    await flushPromises();
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("B title");
  });

  it("keeps form input on 409 and reuses a key when retrying the same payload", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    mocks.savePackage.mockRejectedValue(
      new mocks.EditorialApiError(
        "EDITORIAL_REVISION_CONFLICT",
        "Conflict",
        409,
      ),
    );
    await wrapper.findAll("form")[0]!.trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("текущий ввод сохранён");
    await wrapper.findAll("form")[0]!.trigger("submit");
    await flushPromises();
    expect(mocks.savePackage.mock.calls[0]![2]).toBe(
      mocks.savePackage.mock.calls[1]![2],
    );
  });

  it("requires an explicit second reload before replacing unsaved fields", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.findAll("input")[0]!.setValue("Local title");
    mocks.listPackages.mockResolvedValue([
      pack(ids.projectA, ids.jobA, "Server title", 2),
    ]);
    const reload = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Загрузить сохранённую"))!;
    await reload.trigger("click");
    expect(wrapper.text()).toContain("несохранённые изменения");
    await reload.trigger("click");
    await flushPromises();
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("Server title");
  });

  it("guards a duplicate submit while the first save is pending", async () => {
    let resolveSave: ((value: ReturnType<typeof pack>) => void) | undefined;
    mocks.savePackage.mockImplementation(
      () => new Promise((resolve) => (resolveSave = resolve)),
    );
    const wrapper = mountDialog();
    await flushPromises();
    const form = wrapper.find("form");
    await form.trigger("submit");
    await form.trigger("submit");
    expect(mocks.savePackage).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".form-fields").attributes("disabled")).toBeDefined();
    resolveSave!(pack(ids.projectA, ids.jobA, "A title", 2));
    await flushPromises();
  });

  it("does not write a late save for job A into job B state", async () => {
    let resolveSave: ((value: ReturnType<typeof pack>) => void) | undefined;
    mocks.savePackage.mockImplementation(
      () => new Promise((resolve) => (resolveSave = resolve)),
    );
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await wrapper.setProps({ projectId: ids.projectB, jobId: ids.jobB });
    await flushPromises();
    resolveSave!(pack(ids.projectA, ids.jobA, "Late A", 2));
    await flushPromises();
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("B title");
  });

  it("reuses the create-template key after an unknown response", async () => {
    mocks.createTemplate.mockRejectedValue(new Error("Network"));
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.findAll("input")[1]!.setValue("Manual template");
    const create = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Создать шаблон"))!;
    await create.trigger("click");
    await flushPromises();
    await create.trigger("click");
    await flushPromises();
    expect(mocks.createTemplate.mock.calls[0]![1]).toBe(
      mocks.createTemplate.mock.calls[1]![1],
    );
  });

  it("reuses the thumbnail key when the same file is selected after an unknown response", async () => {
    mocks.uploadThumbnail.mockRejectedValue(new Error("Network"));
    const wrapper = mountDialog();
    await flushPromises();
    const picker = wrapper.find('input[type="file"]');
    const file = new File(["same thumbnail bytes"], "cover.png", {
      type: "image/png",
    });
    Object.assign(file, {
      arrayBuffer: async () =>
        new TextEncoder().encode("same thumbnail bytes").buffer,
    });
    Object.defineProperty(picker.element, "files", {
      configurable: true,
      value: [file],
    });
    await picker.trigger("change");
    await vi.waitFor(() =>
      expect(mocks.uploadThumbnail).toHaveBeenCalledTimes(1),
    );
    Object.defineProperty(picker.element, "files", {
      configurable: true,
      value: [file],
    });
    await picker.trigger("change");
    await vi.waitFor(() =>
      expect(mocks.uploadThumbnail).toHaveBeenCalledTimes(2),
    );
    expect(mocks.uploadThumbnail.mock.calls[0]![2]).toBe(
      mocks.uploadThumbnail.mock.calls[1]![2],
    );
  });

  it("waits for thumbnail hydration before loading the saved form", async () => {
    let resolveThumbnails: ((value: []) => void) | undefined;
    mocks.listThumbnails.mockImplementation(
      () => new Promise((resolve) => (resolveThumbnails = resolve)),
    );
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.find("form").exists()).toBe(false);
    resolveThumbnails!([]);
    await flushPromises();
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("A title");
  });

  it("does not hydrate a cached package before its fresh response", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ["editorial-packages", ids.projectA],
      [pack(ids.projectA, ids.jobA, "Cached title", 1)],
    );
    mocks.listPackages.mockResolvedValue([
      pack(ids.projectA, ids.jobA, "Fresh title", 3),
    ]);
    const wrapper = mountDialog(queryClient);
    await flushPromises();
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("Fresh title");
  });

  it("shows a retry after thumbnail hydration exhausts its retry budget", async () => {
    vi.useFakeTimers();
    mocks.listThumbnails.mockRejectedValue(new Error("Thumbnail unavailable"));
    const wrapper = mountDialog();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(wrapper.text()).toContain(
      "Не удалось загрузить часть редакционных данных.",
    );
    mocks.listThumbnails.mockResolvedValue([]);
    const retry = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Повторить загрузку"))!;
    await retry.trigger("click");
    await flushPromises();
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("A title");
    vi.useRealTimers();
  });
});
