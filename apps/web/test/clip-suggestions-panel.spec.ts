import { webcrypto } from "node:crypto";

import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  accept: vi.fn(),
}));
vi.mock("~/shared/api/clip-generation", async (original) => ({
  ...(await original<object>()),
  createClipGenerationApi: () => api,
}));

import ClipSuggestionsPanel from "~/features/clip-generation/ui/clip-suggestions-panel.vue";

function setup() {
  return mount(ClipSuggestionsPanel, {
    props: {
      projectId: "00000000-0000-4000-8000-000000000001",
      sourceTitle: "Test stream",
      sourceDurationMs: 120_000,
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
        Button: {
          props: ["disabled", "loading"],
          template: '<button :disabled="disabled"><slot /></button>',
        },
        Textarea: {
          props: ["modelValue", "disabled"],
          emits: ["update:modelValue"],
          template:
            '<textarea :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        Checkbox: {
          props: ["modelValue", "disabled", "inputId"],
          emits: ["update:modelValue"],
          template:
            '<input :id="inputId" type="checkbox" :checked="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
        },
      },
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  api.create.mockReset();
  api.list
    .mockReset()
    .mockResolvedValue({ items: [], generationEnabled: true });
  api.accept.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ClipSuggestionsPanel", () => {
  it("retains history and disables generation/acceptance on rollback", async () => {
    api.list.mockResolvedValue({
      generationEnabled: false,
      items: [
        {
          id: "intent-1",
          state: "READY",
          provider: "LOCAL_FIXTURE",
          model: "fixture",
          suggestions: [
            {
              id: "suggestion-1",
              startMs: 1000,
              endMs: 20000,
              title: "Historical moment",
              rationale: "Saved result",
              confidenceBasisPoints: 0,
            },
          ],
        },
      ],
    });
    const wrapper = setup();
    await flushPromises();
    expect(wrapper.text()).toContain("История доступна");
    expect(wrapper.text()).toContain("Historical moment");
    expect(wrapper.find("#clip-transcript").exists()).toBe(false);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Выбрать все")!
      .trigger("click");
    await flushPromises();
    const accept = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Нарезать выбранное"));
    expect(accept?.text()).toContain("Нарезать выбранное (1)");
    expect(accept?.attributes("disabled")).toBeDefined();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.accept).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("reuses the create idempotency key after an unknown network result", async () => {
    api.create
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({ id: "intent-1" });
    const wrapper = setup();
    await flushPromises();
    await wrapper
      .get("#clip-transcript")
      .setValue("00:00:01,000 --> 00:00:20,000\nMoment");
    await wrapper.get("#clip-transfer-consent").setValue(true);
    const action = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Найти моменты"))!;
    await action.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Network unavailable");
    await action.trigger("click");
    await flushPromises();
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[0]?.[0]).toEqual(
      api.create.mock.calls[1]?.[0],
    );
    wrapper.unmount();
  });
  it("requires a valid timed transcript and explicit transfer consent", async () => {
    api.create.mockResolvedValue({ id: "intent-1" });
    const wrapper = setup();
    await flushPromises();

    await wrapper
      .get("#clip-transcript")
      .setValue("00:00:01,000 --> 00:00:20,000\nПолный момент");
    expect(wrapper.text()).toContain(
      "При внешнем provider текст будет передан за пределы Content Factory",
    );
    await wrapper.get("#clip-transfer-consent").setValue(true);
    await flushPromises();
    const action = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Найти моменты"));
    expect(action?.attributes("disabled")).toBeUndefined();

    await action!.trigger("click");
    await flushPromises();
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTitle: "Test stream",
        transcript: [{ startMs: 1_000, endMs: 20_000, text: "Полный момент" }],
        externalProviderTransferAllowed: true,
      }),
    );
    wrapper.unmount();
  });

  it("does not present local fixture output as a quality confidence score", async () => {
    api.list.mockResolvedValue({
      generationEnabled: true,
      items: [
        {
          id: "intent-1",
          state: "READY",
          provider: "LOCAL_FIXTURE",
          model: "local-deterministic-clip-v1",
          suggestions: [
            {
              id: "suggestion-1",
              startMs: 5_000,
              endMs: 20_000,
              title: "Workflow fixture",
              rationale: "Без оценки качества",
              confidenceBasisPoints: 0,
            },
          ],
        },
      ],
    });
    const wrapper = setup();
    await flushPromises();

    expect(wrapper.text()).toContain("проверка workflow без оценки качества");
    expect(wrapper.text()).not.toContain("0%");
    wrapper.unmount();
  });
});
