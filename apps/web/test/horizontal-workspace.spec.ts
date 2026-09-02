import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCuts: vi.fn(),
  getProject: vi.fn(),
  MediaPipelineApiError: class MediaPipelineApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

vi.mock("~/shared/api/projects", () => ({
  createProjectsApi: () => ({ getProject: mocks.getProject }),
}));
vi.mock("~/shared/api/media-pipeline", () => ({
  MediaPipelineApiError: mocks.MediaPipelineApiError,
  createMediaPipelineApi: () => ({
    sourceUrl: (projectId: string) => `/source/${projectId}`,
    createCuts: mocks.createCuts,
  }),
}));

import HorizontalWorkspace from "~/widgets/horizontal-workspace/ui/horizontal-workspace.vue";

const projectA = "00000000-0000-4000-8000-000000000101";
const projectB = "00000000-0000-4000-8000-000000000102";
const projectC = "00000000-0000-4000-8000-000000000103";
const projectD = "00000000-0000-4000-8000-000000000104";

function project(id: string) {
  return {
    id,
    name: `Проект ${id.slice(-3)}`,
    status: "SOURCE_READY" as const,
    source: {
      originalFilename: `source-${id.slice(-3)}.mp4`,
      durationMs: 3_600_000,
    },
  };
}

function mountWorkspace(projectIds: string[]) {
  vi.stubGlobal("useRoute", () => ({
    query: { projectIds: projectIds.join(",") },
    fullPath: `/horizontal?projectIds=${projectIds.join(",")}`,
  }));
  vi.stubGlobal("navigateTo", vi.fn());
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  return mount(HorizontalWorkspace, {
    global: {
      plugins: [
        [PrimeVue, { unstyled: true }],
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({
              defaultOptions: { queries: { retry: false } },
            }),
          },
        ],
      ],
      stubs: {
        NuxtLink: { template: "<a><slot /></a>" },
        PipelineJobCard: { template: "<article />" },
      },
    },
  });
}

async function confirmSingleSegment(
  wrapper: ReturnType<typeof mount>,
  start = "12:46",
  end = "13:21",
): Promise<void> {
  const inputs = wrapper.findAll("input");
  await inputs[0]!.setValue(start);
  await inputs[1]!.setValue(end);
  await wrapper
    .findAll("button")
    .find((button) => button.text() === "Проверить параметры")!
    .trigger("click");
  await flushPromises();
}

function launchButton(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll("button")
    .find((button) => button.text().startsWith("Запустить нарезку"))!;
}

describe("HorizontalWorkspace cut confirmation", () => {
  beforeEach(() => {
    mocks.createCuts.mockReset();
    mocks.getProject.mockImplementation((id: string) =>
      Promise.resolve(project(id)),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows normalized 12:46–13:21 confirmation and sends that exact payload", async () => {
    mocks.createCuts.mockResolvedValue({ jobs: [] });
    const wrapper = mountWorkspace([projectA]);
    await flushPromises();

    await confirmSingleSegment(wrapper);

    expect(wrapper.text()).toContain("00:12:46.000–00:13:21.000");
    expect(wrapper.text()).toContain("длительность 00:00:35.000");
    expect(launchButton(wrapper).attributes("disabled")).toBeUndefined();

    await launchButton(wrapper).trigger("submit");
    await flushPromises();
    expect(mocks.createCuts).toHaveBeenCalledWith({
      projectId: projectA,
      idempotencyKey: expect.any(String),
      segments: [
        {
          clientSegmentId: expect.any(String),
          startMs: 766_000,
          endMs: 801_000,
        },
      ],
    });
  });

  it("hides and blocks a confirmation after an input, marker, add, or remove change", async () => {
    const wrapper = mountWorkspace([projectB]);
    await flushPromises();
    await confirmSingleSegment(wrapper);
    expect(wrapper.text()).toContain("Проверьте параметры перед запуском");

    await wrapper.findAll("input")[0]!.setValue("12:47");
    expect(wrapper.text()).not.toContain("Проверьте параметры перед запуском");
    expect(launchButton(wrapper).attributes("disabled")).toBeDefined();
    await launchButton(wrapper).trigger("submit");
    expect(mocks.createCuts).not.toHaveBeenCalled();

    await wrapper.findAll("input")[0]!.setValue("12:46");
    await confirmSingleSegment(wrapper);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Добавить отрезок")!
      .trigger("click");
    const withSecondSegment = wrapper.findAll("input");
    await withSecondSegment[2]!.setValue("20:00");
    await withSecondSegment[3]!.setValue("20:10");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Проверить параметры")!
      .trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Удалить")!
      .trigger("click");
    expect(wrapper.text()).not.toContain("Проверьте параметры перед запуском");

    await confirmSingleSegment(wrapper);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Установить начало")!
      .trigger("click");
    expect(wrapper.text()).not.toContain("Проверьте параметры перед запуском");
    expect(mocks.createCuts).not.toHaveBeenCalled();
  });

  it("keeps the same unknown-network retry key and exact body", async () => {
    mocks.createCuts
      .mockRejectedValueOnce(
        new mocks.MediaPipelineApiError(
          "NETWORK_ERROR",
          "Не удалось связаться с API.",
          0,
        ),
      )
      .mockResolvedValueOnce({ jobs: [] });
    const wrapper = mountWorkspace([projectC]);
    await flushPromises();
    await confirmSingleSegment(wrapper);

    await launchButton(wrapper).trigger("submit");
    await flushPromises();
    await launchButton(wrapper).trigger("submit");
    await flushPromises();

    expect(mocks.createCuts).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.createCuts.mock.calls;
    expect(second).toEqual(first);
  });

  it("does not invalidate another source's confirmed bounds", async () => {
    const wrapper = mountWorkspace([projectD, projectA]);
    await flushPromises();
    const rows = wrapper.findAll(".source-row");
    const firstInputs = rows[0]!.findAll("input");
    await firstInputs[0]!.setValue("12:46");
    await firstInputs[1]!.setValue("13:21");
    await rows[0]!
      .findAll("button")
      .find((button) => button.text() === "Проверить параметры")!
      .trigger("click");
    const secondInputs = rows[1]!.findAll("input");
    await secondInputs[0]!.setValue("20:00");
    await secondInputs[1]!.setValue("20:30");
    await rows[1]!
      .findAll("button")
      .find((button) => button.text() === "Проверить параметры")!
      .trigger("click");
    await flushPromises();

    await firstInputs[0]!.setValue("12:47");
    expect(rows[0]!.text()).not.toContain("Проверьте параметры перед запуском");
    expect(rows[1]!.text()).toContain("Проверьте параметры перед запуском");
  });
});
