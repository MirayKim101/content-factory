import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ids = {
  project: "00000000-0000-4000-8000-000000000101",
  job: "00000000-0000-4000-8000-000000000102",
  intro: "00000000-0000-4000-8000-000000000103",
  banner: "00000000-0000-4000-8000-000000000104",
};
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  createRender: vi.fn(),
  listRenders: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("~/shared/api/assembly-recipes", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/shared/api/assembly-recipes")>();
  return {
    ...original,
    AssemblyRecipesApiError: mocks.ApiError,
    createAssemblyRecipesApi: () => ({ get: mocks.get, save: mocks.save }),
  };
});
vi.mock("~/shared/api/montage-assets", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/shared/api/montage-assets")>();
  return { ...original, createMontageAssetsApi: () => ({ list: mocks.list }) };
});
vi.mock("~/shared/api/assembly-renders", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/shared/api/assembly-renders")>();
  return {
    ...original,
    createAssemblyRendersApi: () => ({
      create: mocks.createRender,
      list: mocks.listRenders,
    }),
  };
});

import AssemblyRecipeDialog from "~/features/edit-assembly-recipe/ui/assembly-recipe-dialog.vue";

function asset(
  id: string,
  kind: "INTRO" | "BANNER",
  status: "READY" | "PROBE_PENDING" = "READY",
) {
  return {
    id,
    projectId: ids.project,
    sourceId: "00000000-0000-4000-8000-000000000105",
    sourceVersion: 1,
    kind,
    status,
    revision: 1,
    originalFilename: `${kind}-${status}.mp4`,
    contentType: "video/mp4" as const,
    sizeBytes: "1",
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    durationMs: 1_000,
    hasAudio: false,
    probeJobId: null,
    probe: null,
    failure: null,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}
function recipe(revision = 1) {
  return {
    id: "00000000-0000-4000-8000-000000000106",
    projectId: ids.project,
    pipelineJobId: ids.job,
    cutResultArtifact: {
      id: "00000000-0000-4000-8000-000000000107",
      durationMs: 60_000,
      sha256: "a".repeat(64),
      sizeBytes: "1",
      sourceId: "00000000-0000-4000-8000-000000000105",
      sourceVersion: 1,
      recipeVersion: "cut",
    },
    revision: {
      id: "00000000-0000-4000-8000-000000000108",
      revision,
      schemaVersion: "horizontal-assembly-v1" as const,
      configurationFingerprint: "a".repeat(64),
      configuration: {
        introAssetId: ids.intro,
        outroAssetId: null,
        advertisement: null,
        banners: [],
        cta: null,
        audioProfileVersion: "youtube-stereo-v1" as const,
        encodingProfileVersion: "youtube-h264-v1" as const,
      },
      assets: { intro: null, outro: null, advertisement: null, banners: [] },
      createdAt: "2026-09-06T00:00:00.000Z",
    },
    validation: { valid: true as const },
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}
function persistedRender(
  state: "QUEUED" | "PROCESSING" | "RETRY_WAIT" | "READY" | "FAILED_FINAL",
) {
  return {
    id: "00000000-0000-4000-8000-000000000110",
    cutPipelineJobId: ids.job,
    recipeRevision: 1,
    job: { state },
  };
}
function mountDialog(queryClient?: QueryClient) {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  return mount(AssemblyRecipeDialog, {
    props: {
      visible: true,
      projectId: ids.project,
      jobId: ids.job,
      filename: "cut.mp4",
      cutDurationMs: 60_000,
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
        Select: {
          props: ["modelValue", "options"],
          emits: ["update:modelValue"],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in options" :value="item.id || item.value">{{ item.originalFilename || item.label }}</option></select>',
        },
        Button: {
          props: ["disabled", "label"],
          template: '<button :disabled="disabled"><slot />{{ label }}</button>',
        },
      },
    },
  });
}

describe("AssemblyRecipeDialog", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.save.mockReset();
    mocks.list.mockReset();
    mocks.createRender.mockReset();
    mocks.listRenders.mockReset();
    mocks.get.mockResolvedValue(recipe());
    mocks.list.mockResolvedValue([
      asset(ids.intro, "INTRO"),
      asset(ids.banner, "BANNER"),
      asset("00000000-0000-4000-8000-000000000109", "BANNER", "PROBE_PENDING"),
    ]);
    mocks.createRender.mockResolvedValue(persistedRender("QUEUED"));
    mocks.listRenders.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hydrates a saved recipe and exposes only READY exact-kind materials", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    const selects = wrapper.findAll("select");
    expect((selects[0]!.element as HTMLSelectElement).value).toBe(ids.intro);
    const options = selects.flatMap((select) =>
      select.findAll("option").map((option) => option.text()),
    );
    expect(options).toContain("INTRO-READY.mp4");
    expect(options).not.toContain("BANNER-PROBE_PENDING.mp4");
  });

  it("hydrates a successful missing recipe and protects a new draft from a first reload", async () => {
    mocks.get.mockResolvedValue(undefined);
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.findAll("input")[0]!.setValue("Новый CTA");
    const reload = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Загрузить сохранённую"))!;
    await reload.trigger("click");
    expect(wrapper.text()).toContain("несохранённые изменения");
    expect(
      (wrapper.findAll("input")[0]!.element as HTMLInputElement).value,
    ).toBe("Новый CTA");
  });

  it("keeps input after stale 409 until the explicit double-confirmed reload", async () => {
    const wrapper = mountDialog();
    await flushPromises();
    mocks.save.mockRejectedValue(
      new mocks.ApiError("ASSEMBLY_RECIPE_REVISION_CONFLICT", "Conflict", 409),
    );
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("Конфликт revision");
    await wrapper.findAll("input")[0]!.setValue("Локальная правка");
    mocks.get.mockResolvedValue(recipe(2));
    const reload = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Загрузить сохранённую"))!;
    await reload.trigger("click");
    expect(wrapper.text()).toContain("несохранённые изменения");
    await reload.trigger("click");
    await flushPromises();
    expect(wrapper.text()).not.toContain("несохранённые изменения");
  });

  it("removes a ready export from cache before a recipe revision can make it stale", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ["editorial-exports", ids.project],
      [{ id: "ready-export", approvalCurrent: true }],
    );
    mocks.save.mockResolvedValue(recipe(2));
    const wrapper = mountDialog(queryClient);
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(
      queryClient.getQueryData(["editorial-exports", ids.project]),
    ).toEqual([]);
  });

  it("reuses the same save key for an unknown-response retry", async () => {
    mocks.save.mockRejectedValue(new Error("Network"));
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(mocks.save.mock.calls[0]![2]).toBe(mocks.save.mock.calls[1]![2]);
  });

  it("starts only the exact saved revision and retains its identity for an unknown-response retry", async () => {
    mocks.createRender.mockRejectedValueOnce(new Error("Network"));
    const wrapper = mountDialog();
    await flushPromises();
    const assemble = () =>
      wrapper
        .findAll("button")
        .find((button) => button.text().includes("Собрать готовое видео"))!;
    await assemble().trigger("click");
    await flushPromises();
    await assemble().trigger("click");
    await flushPromises();
    expect(mocks.createRender.mock.calls[0]![1]).toBe(1);
    expect(mocks.createRender.mock.calls[0]![2]).toBe(
      mocks.createRender.mock.calls[1]![2],
    );
  });

  it("keeps launch disabled until the render list has confirmed no prior intent", async () => {
    let resolveList: ((items: unknown[]) => void) | undefined;
    mocks.listRenders.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain("Загружаем сохранённый рецепт");
    expect(
      wrapper
        .findAll("button")
        .some((button) => button.text().includes("Собрать готовое видео")),
    ).toBe(false);
    expect(mocks.createRender).not.toHaveBeenCalled();
    resolveList?.([]);
    await flushPromises();
    const assemble = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Собрать готовое видео"))!;
    expect(assemble.attributes("disabled")).toBeUndefined();
  });

  it("fails closed on a render-list error and offers a controlled retry", async () => {
    mocks.listRenders.mockRejectedValue(new Error("list unavailable"));
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain("Запуск заблокирован");
    const assemble = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Собрать готовое видео"))!;
    expect(assemble.attributes("disabled")).toBeDefined();
    expect(mocks.createRender).not.toHaveBeenCalled();
  });

  it("blocks launch when a fresh recipe reload fails but stale recipe data remains cached", async () => {
    mocks.get
      .mockResolvedValueOnce(recipe())
      .mockRejectedValueOnce(new Error("recipe unavailable"));
    const wrapper = mountDialog();
    await flushPromises();
    const reload = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Загрузить сохранённую"))!;
    await reload.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Не удалось загрузить рецепт");
    const assemble = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Собрать готовое видео"))!;
    expect(assemble.attributes("disabled")).toBeDefined();
    await assemble.trigger("click");
    expect(mocks.createRender).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "PROCESSING", "RETRY_WAIT", "READY"] as const)(
    "blocks a duplicate submit for an existing %s exact revision",
    async (state) => {
      mocks.listRenders.mockResolvedValue([persistedRender(state)]);
      const wrapper = mountDialog();
      await flushPromises();
      const assemble = wrapper
        .findAll("button")
        .find((button) => button.text().includes("Собрать готовое видео"))!;
      expect(assemble.attributes("disabled")).toBeDefined();
      await assemble.trigger("click");
      expect(mocks.createRender).not.toHaveBeenCalled();
    },
  );

  it("blocks a terminal exact revision and tells the owner to save a new revision", async () => {
    mocks.listRenders.mockResolvedValue([persistedRender("FAILED_FINAL")]);
    const wrapper = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain("сохраните новую revision");
    const assemble = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Собрать готовое видео"))!;
    await assemble.trigger("click");
    expect(mocks.createRender).not.toHaveBeenCalled();
  });

  it("does not claim a terminal response with a new key was queued", async () => {
    mocks.createRender.mockResolvedValue(persistedRender("FAILED_FINAL"));
    const wrapper = mountDialog();
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Собрать готовое видео"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("сохраните новую revision");
    expect(wrapper.text()).not.toContain("Сборка поставлена в очередь");
  });
});
