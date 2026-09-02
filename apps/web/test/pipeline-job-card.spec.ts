import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PipelineJobCard from "~/entities/pipeline-job/ui/pipeline-job-card.vue";

const jobId = "00000000-0000-4000-8000-000000000001";
const baseJob = {
  id: jobId,
  clientSegmentId: "00000000-0000-4000-8000-000000000002",
  revision: 1,
  state: "QUEUED",
  startMs: 1_000,
  endMs: 3_000,
  totalMs: 2_000,
  attempt: 0,
  retryBudget: 2,
  updatedAt: "2026-09-02T00:00:00.000Z",
};

beforeEach(() => {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PipelineJobCard states", () => {
  it.each([
    ["QUEUED", {}, "Ожидает свободный слот обработки."],
    ["PROCESSING", { processedMs: 1_000 }, "(50%)."],
  ])("renders %s state", async (state, extra, expected) => {
    const wrapper = await mountJob({ ...baseJob, state, ...extra });
    expect(wrapper.text()).toContain(expected);
  });

  it("renders the authoritative READY download", async () => {
    const wrapper = await mountJob({
      ...baseJob,
      state: "READY",
      revision: 4,
      attempt: 2,
      result: {
        filename: "cut.mp4",
        sizeBytes: "2048",
        sha256: "a".repeat(64),
        downloadUrl: `/api/v1/pipeline-jobs/${jobId}/result`,
      },
    });
    expect(wrapper.get("a.download").attributes("href")).toBe(
      `/api/v1/pipeline-jobs/${jobId}/result`,
    );
    expect(wrapper.text()).toContain("Скачать MP4");
  });

  it("offers cloning for terminal failure and emits the original bounds", async () => {
    const wrapper = await mountJob({
      ...baseJob,
      state: "FAILED_FINAL",
      revision: 3,
      attempt: 3,
      failure: {
        code: "CUT_OUTPUT_INVALID",
        message: "Созданный MP4 не прошёл проверку.",
        retryable: false,
      },
    });
    const button = wrapper
      .findAll("button")
      .find((candidate) =>
        candidate.text().includes("Создать новый отрезок с этими границами"),
      );
    expect(button).toBeDefined();
    await button?.trigger("click");
    expect(wrapper.emitted("cloneSegment")).toEqual([
      [{ startMs: 1_000, endMs: 3_000 }],
    ]);
  });

  it("does not regress the visible state when an older revision arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ ...baseJob, revision: 5, state: "PROCESSING" }),
        )
        .mockResolvedValueOnce(response({ ...baseJob, revision: 4 })),
    );
    const wrapper = mountCard();
    await flushPromises();
    expect(wrapper.text()).toContain("Обрабатывается");

    await wrapper
      .findAll("button")
      .find((candidate) => candidate.text().includes("Обновить сейчас"))
      ?.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Обрабатывается");
    expect(wrapper.text()).not.toContain("В очереди");
  });
});

async function mountJob(job: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(job)));
  const wrapper = mountCard();
  await flushPromises();
  return wrapper;
}

function mountCard() {
  return mount(PipelineJobCard, {
    props: { jobId },
    global: {
      plugins: [
        [PrimeVue, { unstyled: true }],
        [VueQueryPlugin, { queryClient: new QueryClient() }],
      ],
    },
  });
}

function response(job: Record<string, unknown>): Response {
  return new Response(JSON.stringify(job), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
