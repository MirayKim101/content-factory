import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCuts: vi.fn(),
  getProject: vi.fn(),
  listProjectJobs: vi.fn(),
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
    listProjectJobs: mocks.listProjectJobs,
  }),
}));

import HorizontalWorkspace from "~/widgets/horizontal-workspace/ui/horizontal-workspace.vue";
import {
  createWorkspaceSourceState,
  isCurrentWorkspaceSource,
  reconcileWorkspaceSource,
} from "~/features/edit-cut-segments/model/workspace-state";

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
      id: "00000000-0000-4000-8000-000000000199",
      status: "READY" as const,
      sourceVersion: 1,
      originalFilename: `source-${id.slice(-3)}.mp4`,
      contentType: "video/mp4" as const,
      sizeBytes: "1",
      sha256: "a".repeat(64),
      durationMs: 3_600_000,
      authorization: {
        sourceVersion: 1,
        status: "CLEARED" as const,
        usable: true,
        basis: "LEGACY_ATTESTATION" as const,
        declarationVersion: "upload-rights-v1",
        decidedAt: "2026-09-01T00:00:00.000Z",
        revision: 1,
      },
    },
  };
}

function mountWorkspace(
  projectIds: string[],
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
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
            queryClient,
          },
        ],
      ],
      stubs: {
        NuxtLink: { template: "<a><slot /></a>" },
        PipelineJobCard: {
          props: ["jobId"],
          template: '<article class="pipeline-job-card">{{ jobId }}</article>',
        },
        Card: {
          template:
            '<article class="source-card"><slot name="content" /></article>',
        },
        Dialog: {
          props: ["visible"],
          emits: ["update:visible"],
          template: `<section v-if="visible" class="test-dialog">
            <button class="close-dialog" @click="$emit('update:visible', false)">Закрыть</button>
            <slot />
          </section>`,
        },
      },
    },
  });
}

async function confirmSingleSegment(
  wrapper: ReturnType<typeof mount>,
  start = "12:46",
  end = "13:21",
): Promise<void> {
  await wrapper
    .findAll("button")
    .find((button) => button.text() === "Настроить нарезки")!
    .trigger("click");
  await flushPromises();
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
    mocks.listProjectJobs.mockResolvedValue({ items: [] });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("clears persisted job ids when the exact source identity changes", () => {
    const state = createWorkspaceSourceState();
    state.jobs = ["00000000-0000-4000-8000-000000000990"];
    reconcileWorkspaceSource(state, "source-a", 1);
    const oldIdentity = state.sourceIdentity;
    state.drafts[0]!.startText = "12:46";
    state.confirmation = {
      segments: [],
      totalDurationMs: 0,
    };
    state.retryIdentity = { fingerprint: "old", key: "old-key" };
    state.submitting = true;
    expect(state.jobs).toHaveLength(1);

    reconcileWorkspaceSource(state, "source-a", 2);
    expect(state.jobs).toEqual([]);
    expect(state.drafts[0]?.startText).toBe("");
    expect(state.confirmation).toBeUndefined();
    expect(state.retryIdentity).toBeUndefined();
    expect(state.submitting).toBe(false);
    expect(isCurrentWorkspaceSource(state, oldIdentity)).toBe(false);
  });

  it("recreates media and closes the editor when the source version changes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = mountWorkspace([projectC], queryClient);
    await flushPromises();
    const firstVideo = wrapper.get(".source-card video").element;
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Настроить нарезки")!
      .trigger("click");
    expect(wrapper.find(".test-dialog").exists()).toBe(true);

    const nextProject = project(projectC);
    nextProject.source.id = "00000000-0000-4000-8000-000000000299";
    nextProject.source.sourceVersion = 2;
    nextProject.source.authorization.sourceVersion = 2;
    queryClient.setQueryData(["project", projectC], nextProject);
    await flushPromises();

    expect(wrapper.get(".source-card video").element).not.toBe(firstVideo);
    expect(wrapper.find(".test-dialog").exists()).toBe(false);
  });

  it("renders five independent player cards in the desktop grid", async () => {
    const projectE = "00000000-0000-4000-8000-000000000105";
    const wrapper = mountWorkspace([
      projectA,
      projectB,
      projectC,
      projectD,
      projectE,
    ]);
    await flushPromises();

    expect(wrapper.findAll(".source-card")).toHaveLength(5);
    expect(wrapper.findAll("video")).toHaveLength(5);
    expect(
      wrapper
        .findAll("button")
        .filter((button) => button.text() === "Настроить нарезки"),
    ).toHaveLength(5);
  });

  it("shows normalized 12:46–13:21 confirmation and sends that exact payload", async () => {
    const jobId = "00000000-0000-4000-8000-000000000201";
    mocks.createCuts.mockResolvedValue({ jobs: [{ id: jobId }] });
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
    await wrapper.find(".close-dialog").trigger("click");

    expect(wrapper.find(".test-dialog").exists()).toBe(false);
    expect(wrapper.find(".source-card .card-jobs").exists()).toBe(true);
    expect(wrapper.find(".source-card .card-jobs").text()).toContain(jobId);
  });

  it("sets a marker from the player inside the selected source dialog", async () => {
    const wrapper = mountWorkspace([projectA]);
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Настроить нарезки")!
      .trigger("click");
    const editorVideo = wrapper.find(".test-dialog video").element;
    Object.defineProperty(editorVideo, "currentTime", {
      configurable: true,
      value: 123.456,
    });

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Установить начало")!
      .trigger("click");

    expect(wrapper.find(".test-dialog input").element.value).toBe(
      "00:02:03.456",
    );
  });

  it("restores persisted jobs onto the source card after a fresh mount", async () => {
    const jobId = "00000000-0000-4000-8000-000000000901";
    mocks.listProjectJobs.mockResolvedValue({
      items: [
        {
          id: jobId,
          clientSegmentId: "00000000-0000-4000-8000-000000000902",
          revision: 3,
          state: "PROCESSING",
          startMs: 1_000,
          endMs: 31_000,
          processedMs: 10_000,
          totalMs: 30_000,
          attempt: 1,
          retryBudget: 2,
          updatedAt: "2026-09-02T12:00:00.000Z",
        },
      ],
    });

    const wrapper = mountWorkspace([projectA]);
    await flushPromises();

    expect(mocks.listProjectJobs).toHaveBeenCalledWith(projectA);
    expect(wrapper.get(".source-card .card-jobs").text()).toContain(jobId);
    expect(wrapper.find(".test-dialog").exists()).toBe(false);
  });

  it("keeps persisted history visible when a new cut batch is submitted", async () => {
    const oldJobId = "00000000-0000-4000-8000-000000000911";
    const newJobId = "00000000-0000-4000-8000-000000000912";
    mocks.listProjectJobs.mockResolvedValue({
      items: [
        {
          id: oldJobId,
          clientSegmentId: "00000000-0000-4000-8000-000000000913",
          revision: 4,
          state: "READY",
          startMs: 1_000,
          endMs: 31_000,
          attempt: 1,
          retryBudget: 2,
          updatedAt: "2026-09-02T12:00:00.000Z",
        },
      ],
    });
    mocks.createCuts.mockResolvedValue({ jobs: [{ id: newJobId }] });
    const wrapper = mountWorkspace([projectB]);
    await flushPromises();

    await confirmSingleSegment(wrapper);
    await launchButton(wrapper).trigger("submit");
    await flushPromises();

    const jobs = wrapper.get(".source-card .card-jobs").text();
    expect(jobs).toContain(oldJobId);
    expect(jobs).toContain(newJobId);
  });

  it("keeps the compact editor surface scrollable and its primary actions reachable", async () => {
    const wrapper = mountWorkspace([projectA]);
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Настроить нарезки")!
      .trigger("click");

    expect(wrapper.find(".dialog-content").exists()).toBe(true);
    expect(wrapper.find(".editor-player-wrap").exists()).toBe(true);
    expect(wrapper.find(".dialog-actions").exists()).toBe(true);
    expect(wrapper.find(".dialog-actions").text()).toContain(
      "Проверить параметры",
    );
  });

  it("pauses the card player before the same source editor can play", async () => {
    const wrapper = mountWorkspace([projectA]);
    await flushPromises();
    const cardVideo = wrapper.get(".source-card video").element;
    const pause = vi.spyOn(cardVideo, "pause").mockImplementation(() => {});
    Object.defineProperty(cardVideo, "paused", {
      configurable: true,
      value: false,
    });

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Настроить нарезки")!
      .trigger("click");

    expect(pause).toHaveBeenCalledOnce();
  });

  it("hides and blocks a confirmation after an input, marker, add, or remove change", async () => {
    const wrapper = mountWorkspace([projectB]);
    await flushPromises();
    await confirmSingleSegment(wrapper);
    expect(wrapper.text()).toContain("Проверьте параметры перед запуском");

    await wrapper.findAll("input")[0]!.setValue("12:47");
    expect(wrapper.text()).not.toContain("Проверьте параметры перед запуском");
    expect(launchButton(wrapper)).toBeUndefined();
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
      .find((button) => button.text() === "Удалить отрезок")!
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
    const settings = wrapper
      .findAll("button")
      .filter((button) => button.text() === "Настроить нарезки");
    await settings[0]!.trigger("click");
    let dialog = wrapper.find(".test-dialog");
    const firstInputs = dialog.findAll("input");
    await firstInputs[0]!.setValue("12:46");
    await firstInputs[1]!.setValue("13:21");
    await dialog
      .findAll("button")
      .find((button) => button.text() === "Проверить параметры")!
      .trigger("click");
    await settings[1]!.trigger("click");
    dialog = wrapper.find(".test-dialog");
    const secondInputs = dialog.findAll("input");
    await secondInputs[0]!.setValue("20:00");
    await secondInputs[1]!.setValue("20:30");
    await dialog
      .findAll("button")
      .find((button) => button.text() === "Проверить параметры")!
      .trigger("click");
    await flushPromises();

    await settings[0]!.trigger("click");
    await wrapper.find(".test-dialog").findAll("input")[0]!.setValue("12:47");
    expect(wrapper.find(".test-dialog").text()).not.toContain(
      "Проверьте параметры перед запуском",
    );
    await settings[1]!.trigger("click");
    expect(wrapper.find(".test-dialog").text()).toContain(
      "Проверьте параметры перед запуском",
    );
  });

  it("fails closed for an unauthorized project id from a direct URL", async () => {
    mocks.getProject.mockResolvedValue({
      ...project(projectA),
      source: {
        ...project(projectA).source,
        authorization: {
          sourceVersion: 1,
          status: "NOT_REVIEWED" as const,
          usable: false,
          revision: 1,
        },
      },
    });
    const wrapper = mountWorkspace([projectA]);
    await flushPromises();

    expect(wrapper.text()).toContain("Просмотр и нарезка заблокированы");
    expect(wrapper.find("video").exists()).toBe(false);
    expect(wrapper.find("form").exists()).toBe(false);
    expect(mocks.createCuts).not.toHaveBeenCalled();
  });
});
