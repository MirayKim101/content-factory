import { webcrypto } from "node:crypto";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), create: vi.fn(), apply: vi.fn(), contentUrl: vi.fn(() => "/candidate.png") }));
const contextApi = vi.hoisted(() => ({ getCutPrompt: vi.fn() }));
vi.mock("~/shared/api/thumbnail-suggestions", async (original) => ({ ...(await original<object>()), createThumbnailSuggestionsApi: () => api }));
vi.mock("~/shared/api/creator-context", async (original) => ({ ...(await original<object>()), createCreatorContextApi: () => contextApi }));

import ThumbnailSuggestionsPanel from "~/widgets/editorial-package/ui/thumbnail-suggestions-panel.vue";
import { ThumbnailSuggestionApiError } from "~/shared/api/thumbnail-suggestions";

const projectId = "11111111-1111-4111-8111-111111111111"; const jobId = "22222222-2222-4222-8222-222222222222"; const intentId = "33333333-3333-4333-8333-333333333333";
const ready = { id: intentId, projectId, cutPipelineJobId: jobId, state: "READY", contractVersion: "editorial-thumbnail-v1", adapterVersion: "local-no-likeness-png-v1", promptBasisVersion: "local-abstract-thumbnail-prompt-v1", candidate: { id: intentId, contentType: "image/png", sizeBytes: "100", sha256: "a".repeat(64), width: 1280, height: 720, likeness: "NONE", safetyDecision: {}, directCostMicrousd: "0", costBasisVersion: "zero-v1" }, failure: null, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" };
function setup() { return mount(ThumbnailSuggestionsPanel, { props: { projectId, jobId, expectedRevision: 2 }, global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) }]], stubs: { Button: { props: ["disabled", "label"], template: '<button :disabled="disabled">{{ label }}</button>' } } } }); }
function button(wrapper: ReturnType<typeof setup>, label: string) { const found = wrapper.findAll("button").find((item) => item.text().includes(label)); if (!found) throw new Error(`Missing ${label}`); return found; }
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("useRuntimeConfig", () => ({ public: { apiBasePath: "/api/v1" } })); for (const fn of Object.values(api)) fn.mockClear(); contextApi.getCutPrompt.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("ThumbnailSuggestionsPanel", () => {
  it("keeps manual upload explicit while the feature flag is disabled", async () => {
    contextApi.getCutPrompt.mockResolvedValue({ revision: { status: "CURRENT" } }); api.list.mockRejectedValue(new ThumbnailSuggestionApiError(503, "THUMBNAIL_SUGGESTIONS_DISABLED"));
    const wrapper = setup(); await flushPromises(); expect(wrapper.text()).toContain("Ручная загрузка доступна ниже"); wrapper.unmount();
  });
  it("reloads, previews and applies an exact durable candidate", async () => {
    contextApi.getCutPrompt.mockResolvedValue({ revision: { id: projectId, sourceContextRevisionId: jobId, status: "CURRENT" } }); api.list.mockResolvedValue([ready]); api.detail.mockResolvedValue(ready); api.apply.mockResolvedValue({ packageId: projectId, packageRevisionId: jobId, revision: 3, thumbnailAssetId: intentId, thumbnailMode: "AI_ASSISTED" });
    const wrapper = setup(); await flushPromises(); expect(wrapper.find("img").attributes("src")).toBe("/candidate.png");
    await button(wrapper, "Применить точный вариант").trigger("click"); await flushPromises();
    expect(api.apply).toHaveBeenCalledWith(projectId, jobId, intentId, expect.any(String), 2); expect(wrapper.emitted("applied")?.[0]?.[0]).toMatchObject({ revision: 3 }); wrapper.unmount();
  });
});
