import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
vi.mock("~/shared/api/editorial-exports", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("~/shared/api/editorial-exports")>();
  return { ...original, createEditorialExportsApi: () => ({ list }) };
});

import EditorialExportCard from "~/entities/editorial-export/ui/editorial-export-card.vue";

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  cut: "00000000-0000-4000-8000-000000000002",
};

function exported(state: "PROCESSING" | "READY" | "FAILED_FINAL") {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    approvalId: "00000000-0000-4000-8000-000000000004",
    approvalCurrent: true,
    approvalCandidateFingerprint: "a".repeat(64),
    projectId: ids.project,
    sourceId: "00000000-0000-4000-8000-000000000005",
    sourceVersion: 1,
    cutPipelineJobId: ids.cut,
    editorialPackageRevisionId: "00000000-0000-4000-8000-000000000006",
    recipeRevisionId: "00000000-0000-4000-8000-000000000007",
    assemblyRenderResultId: "00000000-0000-4000-8000-000000000008",
    exportContractVersion: "editorial-export-zip-v1" as const,
    createdAt: "2026-09-06T00:00:00.000Z",
    job: {
      id: "00000000-0000-4000-8000-000000000009",
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
              basisPoints: 4_250,
              phase: "WRITE_ARCHIVE" as const,
              schemaVersion: "editorial-export-progress-v1" as const,
              updatedAt: "2026-09-06T00:00:00.000Z",
            }
          : null,
      failure:
        state === "FAILED_FINAL"
          ? {
              code: "INPUT_TAMPERED",
              message: "Входной файл изменился",
              retryable: false,
            }
          : null,
    },
    result:
      state === "READY"
        ? {
            completedAt: "2026-09-06T00:01:00.000Z",
            downloadUrl: "/api/v1/editorial-exports/x/content",
            filename: "package.zip",
            manifest: {},
            sha256: "b".repeat(64),
            sizeBytes: "100",
          }
        : null,
  };
}

function mountCard() {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  return mount(EditorialExportCard, {
    props: { projectId: ids.project, cutJobId: ids.cut },
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

describe("EditorialExportCard", () => {
  beforeEach(() => list.mockReset());

  it("keeps real external progress after reload", async () => {
    list.mockResolvedValue([exported("PROCESSING")]);
    const wrapper = mountCard();
    await flushPromises();
    expect(wrapper.text()).toContain("Собираем ZIP · 43%");
    expect(
      (wrapper.find("progress").element as HTMLProgressElement).value,
    ).toBe(43);
  });

  it("shows a ready ZIP download and a controlled terminal failure", async () => {
    list.mockResolvedValue([exported("READY")]);
    const ready = mountCard();
    await flushPromises();
    expect(ready.find("a").attributes("href")).toBe(
      "/api/v1/editorial-exports/x/content",
    );
    list.mockResolvedValue([exported("FAILED_FINAL")]);
    const failed = mountCard();
    await flushPromises();
    expect(failed.text()).toContain("Входной файл изменился");
    expect(failed.text()).toContain("INPUT_TAMPERED");
  });
});
