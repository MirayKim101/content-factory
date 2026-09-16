import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  ids,
  profile,
  reference,
  context,
  prompt,
  summary,
} from "./creator-context-fixtures";
const api = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  listReferences: vi.fn(),
  getAuthorization: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  uploadReference: vi.fn(),
  updateAuthorization: vi.fn(),
  setDefault: vi.fn(),
  getSourceContext: vi.fn(),
  getCutPrompt: vi.fn(),
  saveSourceContext: vi.fn(),
  saveCutPrompt: vi.fn(),
  referenceContentUrl: vi.fn(() => "/api/v1/private-reference"),
}));
vi.mock("~/shared/api/creator-context", async (original) => ({
  ...(await original<object>()),
  createCreatorContextApi: () => api,
}));
import { creatorOperationKey } from "~/features/edit-creator-context/model/attempt-storage";
import { CreatorContextApiError } from "~/shared/api/creator-context";
import Workspace from "~/widgets/creator-profiles-workspace/ui/creator-profiles-workspace.vue";
import ContextDialog from "~/features/edit-creator-context/ui/creator-context-dialog.vue";
const stubs = {
  Button: {
    props: ["label", "disabled"],
    template: '<button :disabled="disabled"><slot />{{ label }}</button>',
  },
  Dialog: {
    props: ["visible"],
    emits: ["update:visible"],
    template:
      '<section v-if="visible"><button @click="$emit(\'update:visible\', false)">close</button><slot /></section>',
  },
  InputText: {
    props: ["modelValue"],
    emits: ["update:modelValue"],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  Textarea: {
    props: ["modelValue"],
    emits: ["update:modelValue"],
    template:
      '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  Checkbox: {
    props: ["modelValue", "inputId"],
    emits: ["update:modelValue"],
    template:
      '<input type="checkbox" :id="inputId" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
  Select: {
    props: ["modelValue", "options"],
    emits: ["update:modelValue", "change"],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value); $emit(\'change\')"><option v-for="item in options" :value="item.id">{{ item.canonicalDisplayName }}</option></select>',
  },
};
const mounted: VueWrapper[] = [];
const clients: QueryClient[] = [];
let routeLeave: () => boolean;
function setup(dialog = false, enabled = true) {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1", aiContextEnabled: enabled },
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  const global = {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    stubs,
  };
  const wrapper = dialog
    ? mount(ContextDialog, {
        props: {
          visible: true,
          projectId: ids.a,
          sourceId: ids.source,
          sourceVersion: 1,
          jobId: ids.job,
          filename: "video.mp4",
        },
        global,
      })
    : mount(Workspace, { global });
  mounted.push(wrapper);
  return { wrapper, client };
}
function button(w: VueWrapper, label: string) {
  const b = w.findAll("button").find((b) => b.text() === label);
  if (!b) throw new Error(`Missing ${label}: ${w.text()}`);
  return b;
}
function field(w: VueWrapper, label: string) {
  const item = w.findAll("label").find((x) => x.text().startsWith(label));
  if (!item) throw new Error(`Missing field ${label}`);
  return item.find("input, textarea, select");
}
async function selectA(w: VueWrapper) {
  await w.findAll("button.profile")[0]!.trigger("click");
  await flushPromises();
}
async function chooseUploadFile(wrapper: VueWrapper) {
  const chosen = new File(["bytes"], "photo.png", { type: "image/png" });
  Object.defineProperty(chosen, "arrayBuffer", {
    value: async () => new TextEncoder().encode("bytes").buffer,
  });
  Object.defineProperty(wrapper.get('input[type="file"]').element, "files", {
    configurable: true,
    value: [chosen],
  });
  await wrapper.get('input[type="file"]').trigger("change");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal("onBeforeRouteLeave", (guard: () => boolean) => {
    routeLeave = guard;
  });
  api.listProfiles.mockResolvedValue([summary(), summary(ids.b)]);
  api.getProfile.mockImplementation(async (id) => profile(id));
  api.listReferences.mockResolvedValue([]);
  api.getSourceContext.mockResolvedValue(context());
  api.getCutPrompt.mockResolvedValue(prompt());
  api.referenceContentUrl.mockReturnValue("/api/v1/private-reference");
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  for (const c of clients.splice(0)) c.clear();
  vi.unstubAllGlobals();
});

describe("Creator profiles acceptance", () => {
  it("hydrates private detail after confirmed dirty switch; never PUTs A notes into B", async () => {
    const { wrapper } = setup();
    await flushPromises();
    expect(wrapper.text()).not.toContain("Private notes");
    await selectA(wrapper);
    await field(wrapper, "Имя").setValue("Edited A");
    await wrapper.findAll("button.profile")[1]!.trigger("click");
    await flushPromises();
    expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
      "Creator B",
    );
    api.updateProfile.mockResolvedValue(profile(ids.b, 2));
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateProfile).toHaveBeenCalledWith(
      ids.b,
      expect.objectContaining({
        editorialNotes: `Private notes ${ids.b}`,
        restrictions: ["Private restriction"],
        expectedRevision: 1,
      }),
      expect.any(String),
    );
  });
  it("preserves hydrated CAS through refetch and exposes explicit conflict reload", async () => {
    const { wrapper, client } = setup();
    await flushPromises();
    await selectA(wrapper);
    await field(wrapper, "Имя").setValue("My draft");
    client.setQueryData(["creator-profile", ids.a], profile(ids.a, 2));
    await flushPromises();
    api.updateProfile.mockRejectedValue(
      new CreatorContextApiError("STALE", "stale", 409),
    );
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateProfile.mock.calls[0]![1].expectedRevision).toBe(1);
    expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
      "My draft",
    );
    api.getProfile.mockResolvedValue(profile(ids.a, 2));
    await button(wrapper, "Загрузить актуальную версию").trigger("click");
    await flushPromises();
    expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
      "Creator A",
    );
  });
  it("reuses exact save identity after lost response and rotates it when body changes", async () => {
    const { wrapper } = setup();
    await flushPromises();
    await selectA(wrapper);
    api.updateProfile.mockRejectedValue(
      new CreatorContextApiError("NETWORK_ERROR", "lost", 0),
    );
    await field(wrapper, "Имя").setValue("Draft");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateProfile.mock.calls[1]![2]).toBe(
      api.updateProfile.mock.calls[0]![2],
    );
    await field(wrapper, "Имя").setValue("Changed");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateProfile.mock.calls[2]![2]).not.toBe(
      api.updateProfile.mock.calls[0]![2],
    );
  });
  it("offers navigation for duplicate official URL without automatic target change", async () => {
    const { wrapper } = setup();
    await flushPromises();
    await selectA(wrapper);
    api.updateProfile.mockRejectedValue(
      new CreatorContextApiError(
        "CREATOR_PROFILE_OFFICIAL_URL_CONFLICT",
        "duplicate",
        409,
        ids.b,
      ),
    );
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
      "Creator A",
    );
    await button(wrapper, "Открыть существующий профиль").trigger("click");
    await flushPromises();
    expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
      "Creator B",
    );
  });
  it("late A success cannot replace B or surface old success", async () => {
    const pending = deferred<ReturnType<typeof profile>>();
    api.updateProfile.mockReturnValue(pending.promise);
    const { wrapper } = setup();
    await flushPromises();
    await selectA(wrapper);
    await field(wrapper, "Имя").setValue("Draft A");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    await wrapper.findAll("button.profile")[1]!.trigger("click");
    await flushPromises();
    pending.resolve(profile(ids.a, 2));
    await flushPromises();
    expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
      "Creator B",
    );
    expect(wrapper.text()).not.toContain("Сохранена версия 2");
  });
  it("guards create and route leave while profile is dirty", async () => {
    const { wrapper } = setup();
    await flushPromises();
    await selectA(wrapper);
    await field(wrapper, "Имя").setValue("Draft");
    vi.mocked(confirm).mockReturnValue(false);
    await button(wrapper, "Создать профиль").trigger("click");
    expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
      "Draft",
    );
    expect(routeLeave()).toBe(false);
  });
  it("keeps upload NOT_REVIEWED and authorization separate from exact default, then reflects revoke", async () => {
    api.listReferences.mockResolvedValue([reference()]);
    const { wrapper } = setup();
    await flushPromises();
    await selectA(wrapper);
    expect(wrapper.find("img").attributes("src")).toBe(
      "/api/v1/private-reference",
    );
    expect(wrapper.text()).toContain(
      "Фото не проверено: использовать внешность пока нельзя",
    );
    await field(wrapper, "Основание").setValue("Written consent");
    await field(wrapper, "Область разрешения").setValue("Commercial image");
    await wrapper.find('input[id^="attest-"]').setValue(true);
    api.updateAuthorization.mockResolvedValue({
      assetId: ids.asset,
      creatorProfileId: ids.a,
      current: reference("CLEARED", 2).currentAuthorization,
      history: [reference("CLEARED", 2).currentAuthorization],
    });
    api.listReferences.mockResolvedValue([reference("CLEARED", 2)]);
    await button(wrapper, "Подтвердить разрешение").trigger("click");
    await flushPromises();
    expect(api.setDefault).not.toHaveBeenCalled();
    const cleared = profile(ids.a, 2);
    cleared.revision.likenessPolicy = "CLEARED_REFERENCE_ONLY";
    cleared.revision.likenessUsability = {
      usable: true,
      blocker: null,
      externalProviderTransferAllowed: false,
    };
    cleared.revision.defaultReference = {
      assetId: ids.asset,
      authorizationRevisionId: ids.auth,
      authorizationRevision: 2,
      authorizationStatus: "CLEARED",
      expiresAt: null,
      externalProviderTransferAllowed: false,
    };
    api.setDefault.mockResolvedValue(cleared);
    api.getProfile.mockResolvedValue(cleared);
    await button(wrapper, "Использовать по умолчанию").trigger("click");
    await flushPromises();
    expect(api.setDefault).toHaveBeenCalledWith(
      ids.a,
      {
        expectedProfileRevision: 1,
        action: "SET",
        assetId: ids.asset,
        authorizationRevisionId: ids.auth,
        authorizationRevision: 2,
      },
      expect.any(String),
    );
    expect(wrapper.get('[data-testid="likeness-status"]').text()).toContain(
      "Использование внешности разрешено",
    );
    const revoked = structuredClone(cleared);
    revoked.revision.likenessUsability = {
      usable: false,
      blocker: "DEFAULT_REFERENCE_REVOKED",
      externalProviderTransferAllowed: false,
    };
    api.getProfile.mockResolvedValue(revoked);
    api.listReferences.mockResolvedValue([reference("REVOKED", 3)]);
    await button(wrapper, "Отозвать разрешение").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("DEFAULT_REFERENCE_REVOKED");
    expect(wrapper.find("img").exists()).toBe(true);
    api.getAuthorization.mockResolvedValue({
      assetId: ids.asset,
      creatorProfileId: ids.a,
      current: reference("REVOKED", 3).currentAuthorization,
      history: [
        reference("REVOKED", 3).currentAuthorization,
        { ...reference("CLEARED", 2).currentAuthorization, id: ids.b },
      ],
    });
    await button(wrapper, "История разрешений").trigger("click");
    await flushPromises();
    expect(wrapper.get('[aria-label="История разрешений"]').text()).toContain(
      "CLEARED",
    );
    expect(wrapper.get('[aria-label="История разрешений"]').text()).toContain(
      "REVOKED",
    );
  });
  it.each([
    ["NETWORK_ERROR", 0],
    ["SERVER_ERROR", 500],
    ["CREATOR_REFERENCE_UPLOAD_IN_PROGRESS", 503],
    ["CREATOR_REFERENCE_OUTCOME_UNKNOWN", 503],
  ] as const)(
    "retains exact file upload identity for ambiguous %s",
    async (code, status) => {
      const { wrapper } = setup();
      await flushPromises();
      await selectA(wrapper);
      const chosen = new File(["bytes"], "photo.png", { type: "image/png" });
      // happy-dom File lacks arrayBuffer in some versions; supply actual bytes explicitly.
      Object.defineProperty(chosen, "arrayBuffer", {
        value: async () => new TextEncoder().encode("bytes").buffer,
      });
      Object.defineProperty(
        wrapper.get('input[type="file"]').element,
        "files",
        {
          configurable: true,
          value: [chosen],
        },
      );
      await wrapper.get('input[type="file"]').trigger("change");
      api.uploadReference.mockRejectedValue(
        new CreatorContextApiError(code, "lost", status),
      );
      await button(wrapper, "Загрузить фото").trigger("click");
      await vi.waitFor(() =>
        expect(api.uploadReference).toHaveBeenCalledTimes(1),
      );
      await flushPromises();
      await button(wrapper, "Загрузить фото").trigger("click");
      await vi.waitFor(() =>
        expect(api.uploadReference).toHaveBeenCalledTimes(2),
      );
      expect(api.uploadReference.mock.calls[1]![2]).toBe(
        api.uploadReference.mock.calls[0]![2],
      );
      expect(api.setDefault).not.toHaveBeenCalled();
    },
  );
  it.each([
    "CREATOR_REFERENCE_STORAGE_FAILED",
    "CREATOR_REFERENCE_FINALIZE_FAILED",
  ])(
    "retires only terminal %s identity and waits for a fresh explicit upload click",
    async (code) => {
      const { wrapper } = setup();
      await flushPromises();
      await selectA(wrapper);
      await chooseUploadFile(wrapper);
      api.uploadReference.mockRejectedValue(
        new CreatorContextApiError(code, "terminal failure", 503),
      );
      await button(wrapper, "Загрузить фото").trigger("click");
      await vi.waitFor(() =>
        expect(api.uploadReference).toHaveBeenCalledTimes(1),
      );
      await flushPromises();
      const firstKey = api.uploadReference.mock.calls[0]![2];
      expect(wrapper.text()).toContain("чтобы начать новую попытку");
      expect(
        sessionStorage.getItem(
          `content-factory.creator-context.reference-upload.${ids.a}`,
        ),
      ).toBeNull();
      await flushPromises();
      expect(api.uploadReference).toHaveBeenCalledTimes(1);
      await button(wrapper, "Загрузить фото").trigger("click");
      await vi.waitFor(() =>
        expect(api.uploadReference).toHaveBeenCalledTimes(2),
      );
      expect(api.uploadReference.mock.calls[1]![2]).not.toBe(firstKey);
      expect(api.setDefault).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "late terminal upload clears only its captured matching key (newer identity=%s)",
    async (replaceOldKey) => {
      const pending = deferred<ReturnType<typeof reference>>();
      api.uploadReference.mockReturnValue(pending.promise);
      const { wrapper } = setup();
      await flushPromises();
      await selectA(wrapper);
      await chooseUploadFile(wrapper);
      await button(wrapper, "Загрузить фото").trigger("click");
      await vi.waitFor(() =>
        expect(api.uploadReference).toHaveBeenCalledTimes(1),
      );
      const newerA = replaceOldKey
        ? creatorOperationKey("reference-upload", ids.a, {
            sha256: "different-file",
          })
        : undefined;
      const keyB = creatorOperationKey("reference-upload", ids.b, {
        sha256: "b-file",
      });
      await wrapper.findAll("button.profile")[1]!.trigger("click");
      await flushPromises();
      pending.reject(
        new CreatorContextApiError(
          "CREATOR_REFERENCE_STORAGE_FAILED",
          "failed",
          503,
        ),
      );
      await flushPromises();
      const storedA = sessionStorage.getItem(
        `content-factory.creator-context.reference-upload.${ids.a}`,
      );
      if (replaceOldKey) expect(JSON.parse(storedA!).key).toBe(newerA);
      else expect(storedA).toBeNull();
      expect(
        JSON.parse(
          sessionStorage.getItem(
            `content-factory.creator-context.reference-upload.${ids.b}`,
          )!,
        ).key,
      ).toBe(keyB);
      expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
        "Creator B",
      );
      expect(wrapper.text()).not.toContain("чтобы начать новую попытку");
    },
  );
  it("preserves rights edited during submission and rebases only to its own exact successful revision", async () => {
    api.listReferences.mockResolvedValue([reference()]);
    const pending = deferred<{
      assetId: string;
      creatorProfileId: string;
      current: ReturnType<typeof reference>["currentAuthorization"];
      history: ReturnType<typeof reference>["currentAuthorization"][];
    }>();
    api.updateAuthorization.mockReturnValueOnce(pending.promise);
    const { wrapper, client } = setup();
    await flushPromises();
    await selectA(wrapper);
    await field(wrapper, "Основание").setValue("Original consent");
    await field(wrapper, "Область разрешения").setValue("Original scope");
    await wrapper.find('input[id^="attest-"]').setValue(true);
    await button(wrapper, "Подтвердить разрешение").trigger("click");
    await flushPromises();
    await field(wrapper, "Основание").setValue("Edited while pending");
    // A later server observation must not become this draft's optimistic base.
    api.listReferences.mockResolvedValue([reference("CLEARED", 3)]);
    pending.resolve({
      assetId: ids.asset,
      creatorProfileId: ids.a,
      current: reference("CLEARED", 2).currentAuthorization,
      history: [reference("CLEARED", 2).currentAuthorization],
    });
    await flushPromises();
    client.setQueryData(
      ["creator-references", ids.a],
      [reference("CLEARED", 3)],
    );
    await flushPromises();
    expect(
      (field(wrapper, "Основание").element as HTMLInputElement).value,
    ).toBe("Edited while pending");
    api.updateAuthorization.mockRejectedValueOnce(
      new CreatorContextApiError("STALE", "stale", 409),
    );
    await button(wrapper, "Подтвердить разрешение").trigger("click");
    await flushPromises();
    expect(api.updateAuthorization.mock.calls[1]![2]).toEqual(
      expect.objectContaining({
        expectedRevision: 2,
        basis: "Edited while pending",
      }),
    );
    expect(
      (field(wrapper, "Основание").element as HTMLInputElement).value,
    ).toBe("Edited while pending");
  });
  it("requires saving a dirty profile before changing default and serializes aggregate mutations", async () => {
    api.listReferences.mockResolvedValue([reference("CLEARED", 2)]);
    const { wrapper } = setup();
    await flushPromises();
    await selectA(wrapper);
    await field(wrapper, "Имя").setValue("Descriptive draft");
    expect(
      button(wrapper, "Использовать по умолчанию").attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.text()).toContain(
      "Перед выбором фото по умолчанию сохраните изменения профиля",
    );
    const pending = deferred<ReturnType<typeof profile>>();
    api.updateProfile.mockReturnValueOnce(pending.promise);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    await button(wrapper, "Использовать по умолчанию").trigger("click");
    expect(api.setDefault).not.toHaveBeenCalled();
    const saved = profile(ids.a, 2);
    saved.revision.editableRevision.canonicalDisplayName = "Descriptive draft";
    api.getProfile.mockResolvedValue(saved);
    pending.resolve(saved);
    await flushPromises();
    const defaultPending = deferred<ReturnType<typeof profile>>();
    api.setDefault.mockReturnValueOnce(defaultPending.promise);
    await button(wrapper, "Использовать по умолчанию").trigger("click");
    await flushPromises();
    expect(api.setDefault.mock.calls[0]![1].expectedProfileRevision).toBe(2);
    expect(wrapper.get("fieldset").attributes("disabled")).toBeDefined();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(api.updateProfile).toHaveBeenCalledTimes(1);
    defaultPending.resolve(profile(ids.a, 3));
    await flushPromises();
  });
  it("retries a failed catalog without discarding an in-progress profile draft", async () => {
    api.listProfiles.mockRejectedValueOnce(
      new CreatorContextApiError("NETWORK_ERROR", "unavailable", 0),
    );
    const { wrapper } = setup();
    await flushPromises();
    expect(wrapper.text()).toContain("Не удалось загрузить каталог.");
    await button(wrapper, "Создать профиль").trigger("click");
    await field(wrapper, "Имя").setValue("Unsaved new creator");
    await field(wrapper, "Личные заметки").setValue("Private draft notes");
    await button(wrapper, "Повторить загрузку каталога").trigger("click");
    await flushPromises();
    expect(api.listProfiles).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll("button.profile")).toHaveLength(2);
    expect(wrapper.text()).not.toContain("Не удалось загрузить каталог.");
    expect((field(wrapper, "Имя").element as HTMLInputElement).value).toBe(
      "Unsaved new creator",
    );
    expect(
      (field(wrapper, "Личные заметки").element as HTMLTextAreaElement).value,
    ).toBe("Private draft notes");
    expect(api.createProfile).not.toHaveBeenCalled();
    expect(api.updateProfile).not.toHaveBeenCalled();
  });
  it("fails closed on detail read error and disabled context", async () => {
    api.getProfile.mockRejectedValue(
      new CreatorContextApiError("AI_CONTEXT_DISABLED", "disabled", 503),
    );
    const { wrapper } = setup();
    await flushPromises();
    await selectA(wrapper);
    expect(wrapper.find("form").exists()).toBe(false);
    expect(wrapper.text()).toContain("Сохранение недоступно");
    const disabled = setup(false, false).wrapper;
    await flushPromises();
    expect(disabled.text()).toContain("Ручной редакционный поток");
    expect(disabled.find("form").exists()).toBe(false);
  });
});

describe("Exact source context and cut prompt acceptance", () => {
  it("round-trips private context with hydrated CAS after cache refresh", async () => {
    const { wrapper, client } = setup(true);
    await flushPromises();
    await field(wrapper, "Название исходника").setValue("Draft source");
    client.setQueryData(["source-context", ids.a, ids.source, 1], context(2));
    await flushPromises();
    api.saveSourceContext.mockRejectedValue(
      new CreatorContextApiError("STALE", "stale", 409),
    );
    await button(wrapper, "Сохранить контекст исходника").trigger("click");
    await flushPromises();
    expect(api.saveSourceContext.mock.calls[0]![3]).toEqual(
      expect.objectContaining({
        expectedRevision: 1,
        operatorNotes: "Private source notes",
        restrictions: ["Context restriction"],
      }),
    );
    expect(
      (field(wrapper, "Название исходника").element as HTMLInputElement).value,
    ).toBe("Draft source");
  });
  it("saving context preserves dirty prompt and requires explicit current-context rebind", async () => {
    const { wrapper } = setup(true);
    await flushPromises();
    await field(wrapper, "Что происходит").setValue("Unsaved prompt");
    await field(wrapper, "Название исходника").setValue("New context");
    api.saveSourceContext.mockResolvedValue(context(2));
    const stale = prompt();
    stale.revision.status = "STALE";
    stale.revision.blockers = ["SOURCE_CONTEXT_CHANGED"];
    api.getCutPrompt.mockResolvedValue(stale);
    await button(wrapper, "Сохранить контекст исходника").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("SOURCE_CONTEXT_CHANGED");
    expect(wrapper.text()).toContain("Связанная версия контекста: 1");
    vi.mocked(confirm).mockReturnValue(false);
    await button(wrapper, "close").trigger("click");
    expect(wrapper.emitted("update:visible")).toBeUndefined();
    await button(wrapper, "Связать с текущей версией контекста").trigger(
      "click",
    );
    api.saveCutPrompt.mockResolvedValue(prompt(2));
    await button(wrapper, "Сохранить инструкцию к нарезке").trigger("click");
    await flushPromises();
    expect(api.saveCutPrompt.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        whatHappens: "Unsaved prompt",
        sourceContextRevision: 2,
        expectedRevision: 1,
      }),
    );
  });
  it("retains exact source and prompt keys through network failures", async () => {
    const { wrapper } = setup(true);
    await flushPromises();
    api.saveSourceContext.mockRejectedValue(
      new CreatorContextApiError("NETWORK_ERROR", "lost", 0),
    );
    api.saveCutPrompt.mockRejectedValue(
      new CreatorContextApiError("NETWORK_ERROR", "lost", 0),
    );
    for (let i = 0; i < 2; i++) {
      await button(wrapper, "Сохранить контекст исходника").trigger("click");
      await flushPromises();
      await button(wrapper, "Сохранить инструкцию к нарезке").trigger("click");
      await flushPromises();
    }
    expect(api.saveSourceContext.mock.calls[0]![4]).toBe(
      api.saveSourceContext.mock.calls[1]![4],
    );
    expect(api.saveCutPrompt.mock.calls[0]![2]).toBe(
      api.saveCutPrompt.mock.calls[1]![2],
    );
  });
  it("isolates late source-version response and mutation from new target", async () => {
    const old = deferred<ReturnType<typeof context>>();
    api.getSourceContext.mockImplementation((_p, _s, version) =>
      version === 1 ? old.promise : Promise.resolve(context(1, 2)),
    );
    const { wrapper, client } = setup(true);
    await flushPromises();
    await wrapper.setProps({ sourceVersion: 2 });
    await flushPromises();
    old.resolve({
      ...context(),
      revision: {
        ...context().revision,
        editableRevision: {
          ...context().revision.editableRevision,
          sourceTitle: "Old version",
        },
      },
    });
    await flushPromises();
    expect(
      (field(wrapper, "Название исходника").element as HTMLInputElement).value,
    ).toBe("Source");
    const saveOld = deferred<ReturnType<typeof context>>();
    api.saveSourceContext.mockReturnValue(saveOld.promise);
    await button(wrapper, "Сохранить контекст исходника").trigger("click");
    await flushPromises();
    await wrapper.setProps({ sourceVersion: 3 });
    await flushPromises();
    saveOld.resolve(context(2, 2));
    await flushPromises();
    expect(
      client.getQueryData(["source-context", ids.a, ids.source, 3]),
    ).not.toEqual(context(2, 2));
    expect(wrapper.text()).not.toContain(
      "Контекст исходника: версия 2 сохранена",
    );
  });
  it("distinguishes not-yet-created404 from failed503 and preserves manual fallback", async () => {
    api.getSourceContext.mockRejectedValue(
      new CreatorContextApiError("NOT_FOUND", "missing", 404),
    );
    api.getCutPrompt.mockRejectedValue(
      new CreatorContextApiError("NOT_FOUND", "missing", 404),
    );
    const { wrapper } = setup(true);
    await flushPromises();
    expect(button(wrapper, "Сохранить контекст исходника").exists()).toBe(true);
    api.getSourceContext.mockRejectedValue(
      new CreatorContextApiError("AI_CONTEXT_DISABLED", "disabled", 503),
    );
    const failed = setup(true).wrapper;
    await flushPromises();
    expect(failed.text()).toContain(
      "Ручной редакционный поток остаётся доступен",
    );
    expect(failed.find("select").exists()).toBe(false);
  });
});
