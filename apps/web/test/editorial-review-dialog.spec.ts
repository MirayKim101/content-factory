import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";

const mocks = vi.hoisted(() => ({
  review: vi.fn(),
  approve: vi.fn(),
  createExport: vi.fn(),
}));
vi.mock("~/shared/api/editorial-approvals", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/shared/api/editorial-approvals")
  >()),
  createEditorialApprovalsApi: () => mocks,
}));
vi.mock("~/shared/api/editorial-exports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/shared/api/editorial-exports")>()),
  createEditorialExportsApi: () => ({ create: mocks.createExport }),
}));

import EditorialReviewDialog from "~/features/review-editorial-package/ui/editorial-review-dialog.vue";

const projectA = "00000000-0000-4000-8000-000000000001";
const projectB = "00000000-0000-4000-8000-000000000002";
const jobA = "00000000-0000-4000-8000-000000000003";
const jobB = "00000000-0000-4000-8000-000000000004";
const renderA = "00000000-0000-4000-8000-000000000005";
const renderB = "00000000-0000-4000-8000-000000000006";

function candidate(
  projectId = projectA,
  jobId = jobA,
  renderId = renderA,
  fingerprint = "a".repeat(64),
) {
  return {
    projectId,
    sourceId: "00000000-0000-4000-8000-000000000007",
    sourceVersion: 1,
    cutPipelineJobId: jobId,
    cutResultArtifactId: "00000000-0000-4000-8000-000000000008",
    approvable: true,
    blockers: [],
    candidateFingerprint: fingerprint,
    editorial: {
      packageId: "00000000-0000-4000-8000-000000000009",
      revisionId: "00000000-0000-4000-8000-000000000010",
      revision: 1,
      processingTemplateRevisionId: "00000000-0000-4000-8000-000000000011",
      title: "Title",
      description: "Description",
      tags: ["one", "two"],
      thumbnail: {
        id: "00000000-0000-4000-8000-000000000012",
        filename: "thumb.png",
        contentType: "image/png",
        sha256: "b".repeat(64),
        sizeBytes: "10",
        contentUrl: "/thumb",
      },
    },
    recipe: {
      id: "00000000-0000-4000-8000-000000000013",
      revisionId: "00000000-0000-4000-8000-000000000014",
      revision: 1,
      configurationFingerprint: "c".repeat(64),
    },
    render: {
      id: renderId,
      resultId: "00000000-0000-4000-8000-000000000015",
      artifactId: "00000000-0000-4000-8000-000000000016",
      artifactSha256: "d".repeat(64),
      artifactSizeBytes: "100",
      renderContractVersion: "horizontal-render-v1",
      durationMs: 60_000,
      contentUrl: "/video",
    },
    processingMetrics: {
      metricsSchemaVersion: "approval-metrics-v1",
      timestampBasisVersion: "persisted-job-attempt-v1",
      cut: {
        initialQueueWaitMs: 0,
        retryWaitMs: 0,
        firstStartToFinishMs: 1,
        activeAttemptMs: 1,
        attemptCount: 1,
        retryCount: 0,
      },
      assembly: {
        initialQueueWaitMs: 0,
        retryWaitMs: 0,
        firstStartToFinishMs: 1,
        activeAttemptMs: 1,
        attemptCount: 1,
        retryCount: 0,
      },
      cutToAssemblyReadyElapsedMs: 1,
      outputDurationMs: 60_000,
      outputBytes: "100",
      directProviderCostMinor: 0,
      costCurrency: "RUB",
      costBasisVersion: "local-direct-provider-cost-v1",
      incompleteReasons: [],
    },
    currentApproval: null,
    latestApproval: null,
  };
}

function mountDialog(
  props = reactive({
    visible: true,
    projectId: projectA,
    jobId: jobA,
    renderId: renderA,
    filename: "source.mp4",
  }),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  const wrapper = mount(EditorialReviewDialog, {
    props,
    global: {
      plugins: [PrimeVue, [VueQueryPlugin, { queryClient }]],
      stubs: {
        Dialog: { props: ["visible"], template: "<section><slot /></section>" },
        Button: {
          template:
            "<button :disabled='$attrs.disabled'><slot>{{ $attrs.label }}</slot></button>",
        },
        Checkbox: {
          props: ["modelValue"],
          template:
            "<input type='checkbox' @change='$emit(\"update:modelValue\", true)' />",
        },
      },
    },
  });
  return { wrapper, props, queryClient };
}

describe("editorial review dialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
    window.localStorage.clear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    mocks.review.mockReset();
    mocks.approve.mockReset();
    mocks.createExport.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists foreground time to A before a fresh B candidate and pauses while hidden", async () => {
    mocks.review
      .mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(
        candidate(projectA, jobA, renderA, "e".repeat(64)),
      );
    const { wrapper, queryClient } = mountDialog();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5_000);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(2_000);
    void queryClient.invalidateQueries({
      queryKey: ["editorial-review", projectA, jobA],
    });
    await flushPromises();
    const draft = JSON.parse(
      window.localStorage.getItem(
        `content-factory:editorial-approval-draft:v1:${jobA}`,
      )!,
    );
    expect(draft).toMatchObject({
      candidateFingerprint: "a".repeat(64),
      manualAttentionMs: 7_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await wrapper.setProps({ visible: false });
    const changed = JSON.parse(
      window.localStorage.getItem(
        `content-factory:editorial-approval-draft:v1:${jobA}`,
      )!,
    );
    expect(changed).toMatchObject({
      candidateFingerprint: "e".repeat(64),
      manualAttentionMs: 3_000,
    });
  });

  it("renders a latest stale approval when no current approval remains", async () => {
    const value = candidate();
    value.latestApproval = {
      state: "STALE",
      staleReasons: ["EDITORIAL_REVISION_CHANGED"],
    };
    mocks.review.mockResolvedValue(value);
    const { wrapper } = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain("Подтверждение устарело");
    expect(wrapper.text()).toContain("EDITORIAL_REVISION_CHANGED");
  });

  it("creates a background ZIP only from the current approval", async () => {
    const value = candidate();
    value.currentApproval = {
      id: "00000000-0000-4000-8000-000000000017",
      state: "CURRENT",
      editorialRevision: 1,
      staleReasons: [],
    };
    mocks.review.mockResolvedValue(value);
    mocks.createExport.mockResolvedValue({ id: "export-id" });
    const { wrapper } = mountDialog();
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((item) => item.text().includes("Экспортировать пакет"))!
      .trigger("click");
    expect(mocks.createExport).toHaveBeenCalledWith(
      value.currentApproval.id,
      expect.any(String),
    );
  });

  it("retries a response-lost approval with the frozen saved tuple after reload", async () => {
    window.localStorage.setItem(
      `content-factory:editorial-approval-draft:v1:${jobA}`,
      JSON.stringify({
        candidateFingerprint: "a".repeat(64),
        manualAttentionMs: 5_000,
        idempotencyKey: "response-lost-key",
      }),
    );
    mocks.review.mockResolvedValue(candidate());
    mocks.approve.mockResolvedValue({});
    const { wrapper } = mountDialog();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    await wrapper.find("input[type='checkbox']").trigger("change");
    await wrapper
      .findAll("button")
      .find((item) => item.text().includes("Подтвердить"))!
      .trigger("click");
    expect(mocks.approve).toHaveBeenCalledWith(
      renderA,
      expect.objectContaining({ manualAttentionMs: 5_000 }),
      "response-lost-key",
    );
    expect(wrapper.text()).toContain("Время проверки зафиксировано");
  });

  it("fails closed for blockers, missing metrics and a render mismatch", async () => {
    const blocked = candidate();
    blocked.blockers = ["RENDER_NOT_READY"];
    blocked.processingMetrics = null;
    mocks.review.mockResolvedValue(blocked);
    const { wrapper } = mountDialog();
    await flushPromises();
    expect(wrapper.text()).toContain("Подтверждение пока недоступно");
    expect(wrapper.text()).toContain("Показатели обработки пока недоступны");
    expect(
      wrapper
        .findAll("button")
        .find((item) => item.text().includes("Подтвердить"))
        ?.attributes("disabled"),
    ).toBeDefined();

    mocks.review.mockResolvedValue(candidate(projectA, jobA, renderB));
    const mismatch = mountDialog();
    await flushPromises();
    expect(mismatch.wrapper.text()).toContain(
      "Эта сборка больше не является текущим кандидатом",
    );
  });

  it("disables approval while an authoritative refresh is still in flight", async () => {
    let resolveRefresh:
      ((value: ReturnType<typeof candidate>) => void) | undefined;
    mocks.review.mockResolvedValueOnce(candidate()).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { wrapper, queryClient } = mountDialog();
    await flushPromises();
    await wrapper.find("input[type='checkbox']").trigger("change");
    const action = () =>
      wrapper
        .findAll("button")
        .find((item) => item.text().includes("Подтвердить"))!;
    expect(action().attributes("disabled")).toBeUndefined();
    void queryClient.invalidateQueries({
      queryKey: ["editorial-review", projectA, jobA],
    });
    await flushPromises();
    expect(action().attributes("disabled")).toBeDefined();
    resolveRefresh?.(candidate());
    await flushPromises();
  });

  it("does not let an old target overwrite B draft or surface a late A failure", async () => {
    let rejectA: ((reason?: unknown) => void) | undefined;
    mocks.review
      .mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(
        candidate(projectB, jobB, renderB, "f".repeat(64)),
      );
    mocks.approve.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    const { wrapper } = mountDialog();
    await flushPromises();
    await wrapper.find("input[type='checkbox']").trigger("change");
    await wrapper
      .findAll("button")
      .find((item) => item.text().includes("Подтвердить"))!
      .trigger("click");
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    window.localStorage.setItem(
      `content-factory:editorial-approval-draft:v1:${jobB}`,
      JSON.stringify({
        candidateFingerprint: "f".repeat(64),
        manualAttentionMs: 41,
        idempotencyKey: "b-key",
      }),
    );
    await wrapper.setProps({
      projectId: projectB,
      jobId: jobB,
      renderId: renderB,
    });
    await flushPromises();
    rejectA?.(new Error("late A failure"));
    await flushPromises();
    expect(wrapper.text()).not.toContain("late A failure");
    expect(wrapper.text()).not.toContain("Не удалось подтвердить версию");
    expect(
      JSON.parse(
        window.localStorage.getItem(
          `content-factory:editorial-approval-draft:v1:${jobB}`,
        )!,
      ),
    ).toMatchObject({ manualAttentionMs: 41, idempotencyKey: "b-key" });
  });
});
