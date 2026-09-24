import { webcrypto } from "node:crypto";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  latestTranscriptForJob: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  create: vi.fn(),
  applyMetadata: vi.fn(),
}));
vi.mock("~/shared/api/research-text", async (original) => ({
  ...(await original<object>()),
  createResearchTextApi: () => api,
}));

import ResearchTextPanel from "~/widgets/editorial-package/ui/research-text-panel.vue";
import { ResearchApiError } from "~/shared/api/research-text";

const jobId = "00000000-0000-4000-8000-000000000001";
const transcriptId = "00000000-0000-4000-8000-000000000002";
const researchId = "00000000-0000-4000-8000-000000000003";
const suggestionId = "00000000-0000-4000-8000-000000000004";

function readyResearch() {
  return {
    id: researchId,
    transcriptIntentId: transcriptId,
    state: "READY",
    snapshot: {
      contractVersion: "editorial-research-v1",
      adapterVersion: "local-manual-research-v1",
      query: "topic",
      freshness: "CURRENT",
      searchedAt: "2026-09-24T00:00:00.000Z",
      freshUntil: "2026-09-25T00:00:00.000Z",
      freshnessPolicyVersion: "research-freshness-24h-v1",
      citations: [],
    },
    suggestion: {
      id: suggestionId,
      title: "Suggested title",
      description: "Suggested description",
      tags: ["one", "two"],
      basisVersion: "editorial-research-v1:local-manual-research-v1",
      citationIds: [],
      claims: [],
    },
    cost: { directCostMicrousd: "0", basisVersion: "local-zero-cost-v1" },
    failure: null,
  };
}

function setup() {
  return mount(ResearchTextPanel, {
    props: {
      jobId,
      expectedRevision: 2,
      title: "Suggested title",
      description: "Suggested description",
      tagsText: "one\ntwo",
    },
    global: {
      plugins: [
        [
          VueQueryPlugin,
          {
            queryClient: new QueryClient({
              defaultOptions: { queries: { retry: false, gcTime: 0 } },
            }),
          },
        ],
      ],
      stubs: {
        InputText: {
          props: ["modelValue"],
          template: '<input :value="modelValue" />',
        },
        Textarea: {
          props: ["modelValue"],
          template: '<textarea :value="modelValue" />',
        },
        Button: {
          props: ["disabled", "label"],
          template: '<button :disabled="disabled">{{ label }}</button>',
        },
      },
    },
  });
}

function action(wrapper: ReturnType<typeof setup>, label: string) {
  const button = wrapper
    .findAll("button")
    .find((candidate) => candidate.text().includes(label));
  if (!button) throw new Error(`Button missing: ${label}`);
  return button;
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  for (const method of Object.values(api)) method.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ResearchTextPanel", () => {
  it("keeps the manual path explicit when no transcript exists", async () => {
    api.latestTranscriptForJob.mockRejectedValue(
      new ResearchApiError(404, "TRANSCRIPT_NOT_FOUND"),
    );
    const wrapper = setup();
    await flushPromises();

    expect(wrapper.text()).toContain("Ручной редактор доступен ниже");
    expect(wrapper.text()).toContain("ещё нет transcript evidence");
    wrapper.unmount();
  });

  it("reloads a durable suggestion and applies the exact current revision", async () => {
    const ready = readyResearch();
    api.latestTranscriptForJob.mockResolvedValue({
      id: transcriptId,
      state: "READY",
    });
    api.list.mockResolvedValue([ready]);
    api.detail.mockResolvedValue(ready);
    api.applyMetadata.mockResolvedValue({
      packageId: "00000000-0000-4000-8000-000000000005",
      packageRevisionId: "00000000-0000-4000-8000-000000000006",
      revision: 3,
      title: ready.suggestion.title,
      description: ready.suggestion.description,
      tags: ready.suggestion.tags,
      metadataMode: "AI_ASSISTED",
      thumbnailAssetId: null,
    });
    const wrapper = setup();
    await flushPromises();
    await action(wrapper, "Перенести в поля").trigger("click");
    expect(wrapper.emitted("loadSuggestion")?.[0]?.[0]).toEqual(
      ready.suggestion,
    );

    await action(wrapper, "Применить текущие поля").trigger("click");
    await flushPromises();
    expect(api.applyMetadata).toHaveBeenCalledWith(
      researchId,
      expect.any(String),
      {
        expectedEditorialRevision: 2,
        title: "Suggested title",
        description: "Suggested description",
        tags: ["one", "two"],
      },
    );
    expect(wrapper.emitted("applied")?.[0]?.[0]).toMatchObject({ revision: 3 });
    wrapper.unmount();
  });
});
