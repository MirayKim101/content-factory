import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MediaLibrary from "~/widgets/media-library/ui/media-library.vue";

const projectId = "00000000-0000-4000-8000-000000000001";
const page = {
  items: [
    {
      id: projectId,
      name: "Запись эфира",
      status: "SOURCE_READY",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
      source: {
        id: "00000000-0000-4000-8000-000000000002",
        status: "READY",
        sourceVersion: 1,
        addedAt: "2026-09-02T00:00:00.000Z",
        originalFilename: "stream.mp4",
        contentType: "video/mp4",
        sizeBytes: "1024",
        durationMs: 10_000,
        authorization: {
          sourceVersion: 1,
          status: "CLEARED",
          usable: true,
          basis: "LEGACY_ATTESTATION",
          declarationVersion: "upload-rights-v1",
          decidedAt: "2026-09-02T00:00:00.000Z",
          revision: 1,
        },
      },
      cutJobCounts: { total: 1, ready: 1, failed: 0 },
    },
  ],
  nextCursor: null,
};

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function mountLibrary(queryClient = createQueryClient()) {
  return mount(MediaLibrary, {
    global: {
      plugins: [
        [PrimeVue, { unstyled: true }],
        [VueQueryPlugin, { queryClient }],
      ],
      stubs: { NuxtLink: { template: "<a><slot /></a>" } },
    },
  });
}

describe("MediaLibrary render states", () => {
  beforeEach(() => {
    vi.stubGlobal("useRoute", () => ({ query: {} }));
    vi.stubGlobal("navigateTo", vi.fn());
    vi.stubGlobal("useRuntimeConfig", () => ({
      public: { apiBasePath: "/api/v1" },
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders only the list after a normal successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(page)));
    const wrapper = mountLibrary();
    await flushPromises();
    expect(wrapper.text()).toContain("Запись эфира");
    expect(wrapper.text()).not.toContain("Медиатека пока пуста");
  });

  it("blocks selection and requires an explicit dialog for an unreviewed source", async () => {
    const unreviewed = structuredClone(page);
    unreviewed.items[0]!.source.authorization = {
      sourceVersion: 1,
      status: "NOT_REVIEWED",
      usable: false,
      basis: undefined,
      declarationVersion: undefined,
      decidedAt: undefined,
      revision: 4,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(unreviewed)));
    const wrapper = mountLibrary();
    await flushPromises();

    const selection = wrapper.get('input[aria-label="Выбрать stream.mp4"]');
    expect(selection.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Требуется подтверждение прав");
    const open = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Подтвердить права"));
    expect(open).toBeDefined();
    await open!.trigger("click");
    await flushPromises();
    expect(document.body.textContent).toContain(
      "Подтверждение относится только к версии 1 файла «stream.mp4»",
    );
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Подтвердить",
    );
    expect(confirm?.disabled).toBe(true);
  });

  it("keeps the rendered list with a safe stale-error banner", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(page))
      .mockResolvedValueOnce(
        response({ error: { code: "X", message: "x" } }, false),
      );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = createQueryClient();
    const wrapper = mountLibrary(queryClient);
    await flushPromises();
    await queryClient.refetchQueries({ queryKey: ["project-library"] });
    await flushPromises();
    expect(wrapper.text()).toContain("Запись эфира");
    expect(wrapper.text()).toContain("Не удалось обновить медиатеку");
    expect(wrapper.text()).not.toContain("Медиатека пока пуста");
  });
});
