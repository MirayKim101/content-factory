import { webcrypto } from "node:crypto";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context, ids, prompt } from "./creator-context-fixtures";
import { evidence, scope } from "./frame-evidence-fixtures";
const api = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  contentUrl: vi.fn(
    (intent: string, frame: string) =>
      `/api/v1/frame-evidence/${intent}/frames/${frame}/content`,
  ),
}));
const contexts = vi.hoisted(() => ({
  getSourceContext: vi.fn(),
  getCutPrompt: vi.fn(),
}));
vi.mock("~/shared/api/frame-evidence", async (original) => ({
  ...(await original<object>()),
  createFrameEvidenceApi: () => api,
}));
vi.mock("~/shared/api/creator-context", () => ({
  createCreatorContextApi: () => contexts,
}));
import Dialog from "~/features/frame-evidence/ui/frame-evidence-dialog.vue";
import { FrameEvidenceApiError } from "~/shared/api/frame-evidence";
const mounted: VueWrapper[] = [];
const clients: QueryClient[] = [];
let enabled = true;
let contextEnabled = true;
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  const wrapper = mount(Dialog, {
    props: {
      visible: true,
      projectId: scope.projectId,
      sourceId: scope.sourceId,
      sourceVersion: scope.sourceVersion,
      jobId: scope.cutPipelineJobId,
      filename: "source.mp4",
    },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: client }]],
      stubs: {
        Dialog: {
          props: ["visible"],
          template: '<section v-if="visible"><slot /></section>',
        },
        Button: {
          props: ["disabled"],
          template: '<button :disabled="disabled"><slot /></button>',
        },
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}
function action(wrapper: VueWrapper, label: string) {
  const found = wrapper
    .findAll("button")
    .find((button) => button.text().includes(label));
  if (!found) throw new Error(`Button missing: ${label}`);
  return found;
}
beforeEach(() => {
  sessionStorage.clear();
  enabled = true;
  contextEnabled = true;
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: {
      apiBasePath: "/api/v1",
      aiContextEnabled: contextEnabled,
      editorialFramesEnabled: enabled,
    },
  }));
  for (const fn of [
    api.create,
    api.list,
    api.get,
    contexts.getSourceContext,
    contexts.getCutPrompt,
  ])
    fn.mockReset();
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.get.mockResolvedValue(evidence());
  api.create.mockResolvedValue(evidence("QUEUED"));
  contexts.getSourceContext.mockResolvedValue(context());
  contexts.getCutPrompt.mockResolvedValue(prompt());
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("sparse-frame operator workflow", () => {
  it("admits the current chain without requiring a reference photo", async () => {
    const wrapper = setup();
    await flushPromises();
    expect(
      action(wrapper, "Подготовить три кадра").attributes("disabled"),
    ).toBeUndefined();
    await action(wrapper, "Подготовить три кадра").trigger("click");
    await flushPromises();
    expect(api.create).toHaveBeenCalledWith(
      scope,
      { sourceContextRevisionId: ids.context, cutPromptRevisionId: ids.prompt },
      expect.any(String),
    );
  });
  it("keeps exact request/key after unknown outcome and reload even if prompt is now stale", async () => {
    api.create.mockRejectedValueOnce(
      new FrameEvidenceApiError("NETWORK_ERROR", "Нет связи"),
    );
    const first = setup();
    await flushPromises();
    await action(first, "Подготовить три кадра").trigger("click");
    await flushPromises();
    const firstArgs = api.create.mock.calls[0];
    first.unmount();
    const stale = prompt(2);
    stale.revision.status = "STALE";
    contexts.getCutPrompt.mockResolvedValue(stale);
    const reloaded = setup();
    await flushPromises();
    expect(reloaded.text()).toContain(
      "Результат предыдущего запроса ещё не подтверждён",
    );
    await action(reloaded, "Уточнить результат запроса").trigger("click");
    await flushPromises();
    expect(api.create.mock.calls[1]).toEqual(firstArgs);
  });
  it("shows stale historical images when exact source bytes remain readable", async () => {
    const item = evidence();
    item.currentUse = {
      ...item.currentUse,
      usableForGeneration: false,
      blockers: ["CUT_PROMPT_STALE"],
    };
    api.list.mockResolvedValue({ items: [item], nextCursor: null });
    api.get.mockResolvedValue(item);
    const wrapper = setup();
    await flushPromises();
    expect(wrapper.findAll("img")).toHaveLength(3);
    expect(wrapper.text()).toContain("Контекст этого набора устарел");
    expect(wrapper.text()).toContain("00:00:01.040");
  });
  it("never requests image bytes when exact source rights deny them", async () => {
    const item = evidence();
    item.contentAccess = {
      bytesReadable: false,
      blocker: "SOURCE_AUTHORIZATION_REQUIRED",
    };
    api.list.mockResolvedValue({ items: [item], nextCursor: null });
    api.get.mockResolvedValue(item);
    const wrapper = setup();
    await flushPromises();
    expect(wrapper.findAll("img")).toHaveLength(0);
    expect(wrapper.text()).toContain("Просмотр кадров закрыт");
  });
  it.each([true, false])(
    "keeps historical gallery with admission disabled and context flag %s",
    async (contextFlag) => {
      enabled = false;
      contextEnabled = contextFlag;
      api.list.mockResolvedValue({ items: [evidence()], nextCursor: null });
      const wrapper = setup();
      await flushPromises();
      expect(wrapper.findAll("img")).toHaveLength(3);
      expect(
        action(wrapper, "Подготовить новый набор").attributes("disabled"),
      ).toBeDefined();
      expect(api.create).not.toHaveBeenCalled();
    },
  );
  it.each(["PROCESSING", "RETRY_WAIT", "FAILED_FINAL"] as const)(
    "restores %s without an automatic new request",
    async (state) => {
      const item = evidence(state);
      if (state === "FAILED_FINAL")
        item.job.failure = {
          code: "FRAME_WORK_DEADLINE_EXCEEDED",
          message: "Время обработки истекло",
        };
      api.list.mockResolvedValue({ items: [item], nextCursor: null });
      api.get.mockResolvedValue(item);
      const wrapper = setup();
      await flushPromises();
      expect(api.create).not.toHaveBeenCalled();
      expect(wrapper.findAll("img")).toHaveLength(0);
      if (state === "PROCESSING")
        expect(wrapper.get("progress").attributes("value")).toBe("3500");
      if (state === "RETRY_WAIT")
        expect(wrapper.text()).toContain("Обработка повторится автоматически");
      if (state === "FAILED_FINAL")
        expect(wrapper.text()).toContain("Время обработки истекло");
    },
  );
  it("does not switch the new cut to a late response from the old target", async () => {
    let resolve!: (value: ReturnType<typeof evidence>) => void;
    api.create.mockReturnValue(
      new Promise<ReturnType<typeof evidence>>((done) => {
        resolve = done;
      }),
    );
    const wrapper = setup();
    await flushPromises();
    await action(wrapper, "Подготовить три кадра").trigger("click");
    await wrapper.setProps({ jobId: ids.asset });
    await flushPromises();
    resolve(evidence("QUEUED"));
    await flushPromises();
    expect(api.get).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("Набор кадров не найден");
  });
  it("does not admit new work from an older history page while the newest page has active work", async () => {
    const active = evidence("PROCESSING"),
      old = evidence();
    old.id = ids.asset;
    api.list.mockImplementation((_scope, cursor) =>
      Promise.resolve(
        cursor
          ? { items: [old], nextCursor: null }
          : { items: [active], nextCursor: "older-page" },
      ),
    );
    api.get.mockImplementation((id) =>
      Promise.resolve(id === old.id ? old : active),
    );
    const wrapper = setup();
    await flushPromises();
    await action(wrapper, "Более ранние наборы").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("img")).toHaveLength(3);
    expect(
      action(wrapper, "Подготовить новый набор").attributes("disabled"),
    ).toBeDefined();
    await action(wrapper, "Подготовить новый набор").trigger("click");
    expect(api.create).not.toHaveBeenCalled();
    await action(wrapper, "К новым наборам").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Обработка");
  });

  it("blocks a new request for a stale prompt and offers explicit context repair", async () => {
    const stale = prompt();
    stale.revision.status = "STALE";
    contexts.getCutPrompt.mockResolvedValue(stale);
    const wrapper = setup();
    await flushPromises();
    expect(
      action(wrapper, "Подготовить три кадра").attributes("disabled"),
    ).toBeDefined();
    await action(wrapper, "Открыть контекст нарезки").trigger("click");
    expect(wrapper.emitted("editContext")).toHaveLength(1);
  });
});
