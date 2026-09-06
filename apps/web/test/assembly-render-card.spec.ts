import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
vi.mock("~/shared/api/assembly-renders", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/shared/api/assembly-renders")>();
  return { ...original, createAssemblyRendersApi: () => ({ list }) };
});

import AssemblyRenderCard from "~/entities/assembly-render/ui/assembly-render-card.vue";

const ids = {
  render: "00000000-0000-4000-8000-000000000201",
  project: "00000000-0000-4000-8000-000000000202",
  job: "00000000-0000-4000-8000-000000000203",
};
function render(state: "PROCESSING" | "READY" | "FAILED_FINAL" | "RETRY_WAIT") {
  return {
    id: ids.render,
    projectId: ids.project,
    sourceId: "00000000-0000-4000-8000-000000000204",
    sourceVersion: 1,
    cutPipelineJobId: ids.job,
    cutResultArtifactId: "00000000-0000-4000-8000-000000000205",
    assemblyRecipeId: "00000000-0000-4000-8000-000000000206",
    recipeRevisionId: "00000000-0000-4000-8000-000000000207",
    recipeRevision: 1,
    configurationFingerprint: "a".repeat(64),
    expectedDurationMs: 60_000,
    renderContractVersion: "horizontal-render-v1" as const,
    audioProfileVersion: "youtube-stereo-v1" as const,
    encodingProfileVersion: "youtube-h264-v1" as const,
    inputs: [],
    createdAt: "2026-09-06T00:00:00.000Z",
    job: {
      id: "00000000-0000-4000-8000-000000000208",
      state,
      attempt: 1,
      retryBudget: 2,
      revision: 1,
      admissionReason: null,
      nextAttemptAt: null,
      progress:
        state === "PROCESSING"
          ? {
              attemptNumber: 1,
              basisPoints: 4_200,
              phase: "ENCODE",
              schemaVersion: "assembly-progress-v1",
              updatedAt: "2026-09-06T00:00:00.000Z",
            }
          : null,
      failure:
        state === "FAILED_FINAL"
          ? {
              code: "ENCODE_FAILED",
              message: "Невозможно собрать файл",
              retryable: false,
            }
          : null,
    },
    result:
      state === "READY"
        ? {
            filename: "ready.mp4",
            sizeBytes: "123",
            downloadUrl: "/api/v1/assembly-renders/x/content",
            durationMs: 60_000,
            videoCodec: "h264",
            audioCodec: "aac",
            width: 1920,
            height: 1080,
            fpsNumerator: 30,
            fpsDenominator: 1,
            pixelFormat: "yuv420p",
            audioChannels: 2,
            audioSampleRate: 48_000,
            ffmpegVersion: "x",
            ffprobeVersion: "x",
            sha256: "a".repeat(64),
            integratedLoudnessLufs: -14,
            truePeakDbtp: -1,
            normalizationProfileResult: "ok",
            completedAt: "2026-09-06T00:00:00.000Z",
          }
        : null,
  };
}
function mountCard() {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  return mount(AssemblyRenderCard, {
    props: { projectId: ids.project, cutJobId: ids.job },
    global: {
      plugins: [
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({
              defaultOptions: { queries: { retry: false } },
            }),
          },
        ],
      ],
      stubs: { Button: { template: "<button><slot /></button>" } },
    },
  });
}

describe("AssemblyRenderCard", () => {
  beforeEach(() => list.mockReset());

  it("restores real phase and rounded percent after a reload", async () => {
    list.mockResolvedValue([render("PROCESSING")]);
    const wrapper = mountCard();
    await flushPromises();
    expect(wrapper.text()).toContain("Кодируем видео · 42%");
    expect(
      (wrapper.find("progress").element as HTMLProgressElement).value,
    ).toBe(42);
  });

  it("shows a Range-capable ready download and a controlled failure", async () => {
    list.mockResolvedValue([render("READY")]);
    const ready = mountCard();
    await flushPromises();
    expect(ready.find("a").attributes("href")).toBe(
      "/api/v1/assembly-renders/x/content",
    );
    list.mockResolvedValue([render("FAILED_FINAL")]);
    const failed = mountCard();
    await flushPromises();
    expect(failed.text()).toContain("Невозможно собрать файл");
    expect(failed.text()).toContain("ENCODE_FAILED");
  });

  it("explains retry budget as retries after the first attempt", async () => {
    list.mockResolvedValue([render("RETRY_WAIT")]);
    const wrapper = mountCard();
    await flushPromises();
    expect(wrapper.text()).toContain("Попытка 1 из 3");
  });
});
