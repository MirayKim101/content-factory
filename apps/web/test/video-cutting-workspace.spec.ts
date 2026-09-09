import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectId = "00000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({ project: undefined as unknown }));

vi.mock("~/entities/project/model/use-cut-project", () => ({
  useCutProject: () => ({
    data: { value: mocks.project },
    isLoading: { value: false },
    isError: { value: false },
  }),
}));
vi.mock("~/features/submit-video-cuts/model/use-submit-video-cuts", () => ({
  useSubmitVideoCuts: () => ({
    isPending: { value: false },
    mutateAsync: vi.fn(),
  }),
}));

import VideoCuttingWorkspace from "~/widgets/video-cutting-workspace/ui/video-cutting-workspace.vue";

describe("VideoCuttingWorkspace authorization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not create a playback URL for local-only evidence in manual mode", () => {
    mocks.project = {
      id: projectId,
      name: "Локальный исходник",
      status: "SOURCE_READY",
      source: {
        sourceVersion: 1,
        originalFilename: "stream.mp4",
        durationMs: 60_000,
        authorization: {
          sourceVersion: 1,
          status: "CLEARED",
          usable: false,
          basis: "LOCAL_DEVELOPMENT_AUTO",
          revision: 2,
        },
      },
    };
    vi.stubGlobal("useRoute", () => ({ query: { projectId } }));
    vi.stubGlobal("useRuntimeConfig", () => ({
      public: { apiBasePath: "/api/v1" },
    }));
    vi.stubGlobal("navigateTo", vi.fn());

    const wrapper = mount(VideoCuttingWorkspace, {
      global: {
        stubs: {
          NuxtLink: { template: "<a><slot /></a>" },
          PipelineJobCard: { template: "<article />" },
        },
      },
    });

    expect(wrapper.text()).toContain("Просмотр и нарезка заблокированы");
    expect(wrapper.find("video").exists()).toBe(false);
    expect(wrapper.find("form").exists()).toBe(false);
  });
});
