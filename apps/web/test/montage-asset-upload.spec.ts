import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("~/shared/api/montage-assets", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/shared/api/montage-assets")>();
  return {
    ...actual,
    createMontageAssetsApi: () => ({ upload: mocks.upload }),
  };
});

import {
  clearActiveMontageAttempt,
  loadActiveMontageAttempt,
  saveActiveMontageAttempt,
} from "~/features/upload-montage-asset/model/active-montage-attempt-storage";
import MontageAssetUpload from "~/features/upload-montage-asset/ui/montage-asset-upload.vue";

const projectId = "00000000-0000-4000-8000-000000000001";
const otherProjectId = "00000000-0000-4000-8000-000000000002";
const file = () =>
  new File(["video"], "advertisement.mp4", {
    type: "video/mp4",
    lastModified: 1_700_000_000_000,
  });

function mountUpload() {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBasePath: "/api/v1" },
  }));
  return mount(MontageAssetUpload, {
    props: { projectId },
    global: {
      stubs: {
        Button: {
          props: ["disabled", "loading", "label"],
          template: '<button :disabled="disabled"><slot />{{ label }}</button>',
        },
        Message: { template: "<p><slot /></p>" },
        ProgressBar: {
          props: ["value"],
          template: '<p class="progress">{{ value }}%<slot /></p>',
        },
        Select: {
          props: ["options", "modelValue"],
          template: "<select />",
        },
      },
    },
  });
}

async function chooseFile(
  wrapper: ReturnType<typeof mount>,
  nextFile: File,
): Promise<void> {
  const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [nextFile],
  });
  await wrapper.get('input[type="file"]').trigger("change");
}

describe("MontageAssetUpload", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.upload.mockReset();
  });
  afterEach(() => {
    clearActiveMontageAttempt();
    vi.unstubAllGlobals();
  });

  it("reuses the durable key after reload when the same file is reselected", async () => {
    saveActiveMontageAttempt({
      projectId,
      kind: "ADVERTISEMENT",
      idempotencyKey: "web-montage-recovered-key",
      fingerprint: {
        name: "advertisement.mp4",
        size: 5,
        lastModified: 1_700_000_000_000,
        type: "video/mp4",
      },
    });
    mocks.upload.mockRejectedValue(new Error("offline"));
    const wrapper = mountUpload();
    await chooseFile(wrapper, file());
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(mocks.upload.mock.calls[0]?.[0].idempotencyKey).toBe(
      "web-montage-recovered-key",
    );
  });

  it("resets retry progress to zero so its first new event is shown", async () => {
    let rejectFirst: ((reason: unknown) => void) | undefined;
    let rejectSecond: ((reason: unknown) => void) | undefined;
    mocks.upload
      .mockImplementationOnce(
        (request) =>
          new Promise((_, reject) => {
            request.onUploadProgress?.({ loaded: 90, total: 100 });
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        (request) =>
          new Promise((_, reject) => {
            request.onUploadProgress?.({ loaded: 10, total: 100 });
            rejectSecond = reject;
          }),
      );
    const wrapper = mountUpload();
    await chooseFile(wrapper, file());
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get(".progress").text()).toContain("90%");
    rejectFirst!(new Error("offline"));
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get(".progress").text()).toContain("10%");
    rejectSecond!(new Error("offline"));
    await flushPromises();
  });

  it("guards a duplicate submit while an upload is pending", async () => {
    mocks.upload.mockImplementation(() => new Promise(() => undefined));
    const wrapper = mountUpload();
    await chooseFile(wrapper, file());
    await wrapper.find("form").trigger("submit");
    await wrapper.find("form").trigger("submit");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("aborts A and clears its transient file when project changes to B without deleting durable A", async () => {
    mocks.upload.mockImplementation(() => new Promise(() => undefined));
    const wrapper = mountUpload();
    await chooseFile(wrapper, file());
    await wrapper.find("form").trigger("submit");
    const request = mocks.upload.mock.calls[0]?.[0];
    await wrapper.setProps({ projectId: otherProjectId });
    await flushPromises();

    expect(request.projectId).toBe(projectId);
    expect(request.signal.aborted).toBe(true);
    expect(wrapper.text()).toContain("Файл не выбран");
    expect(loadActiveMontageAttempt()?.projectId).toBe(projectId);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit discard before a mismatched recovered attempt can be replaced", async () => {
    saveActiveMontageAttempt({
      projectId,
      kind: "ADVERTISEMENT",
      idempotencyKey: "web-montage-old-key",
      fingerprint: {
        name: "different.mp4",
        size: 1,
        lastModified: 1,
        type: "video/mp4",
      },
    });
    mocks.upload.mockRejectedValue(new Error("offline"));
    const wrapper = mountUpload();
    await chooseFile(wrapper, file());
    await wrapper.find("form").trigger("submit");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("незавершённая загрузка");
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Отменить сохранённую"))!
      .trigger("click");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it("aborts the active request during unmount without surfacing a network error", async () => {
    mocks.upload.mockImplementation(
      (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const wrapper = mountUpload();
    await chooseFile(wrapper, file());
    await wrapper.find("form").trigger("submit");
    const request = mocks.upload.mock.calls[0]?.[0];
    wrapper.unmount();
    await flushPromises();
    expect(request.signal.aborted).toBe(true);
  });
});
