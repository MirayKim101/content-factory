import { flushPromises, mount } from "@vue/test-utils";
import PrimeVue from "primevue/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProjectSelect from "~/shared/ui/project-select.vue";

describe("ProjectSelect native PrimeVue keyboard contract", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("retains labelled focus and selection across ArrowDown, Enter and Escape", async () => {
    const options = [
      { id: "first", name: "Первый проект", detail: "first.mp4 · 12345678" },
      {
        id: "second",
        name: "Длинное название проекта для проверки доступного списка",
        detail: "long-unbroken-file-name-with-no-spaces.mp4 · 87654321",
      },
    ];
    const wrapper = mount(ProjectSelect, {
      attachTo: document.body,
      props: {
        inputId: "keyboard-project",
        modelValue: "first",
        options,
        ariaLabel: "Выбрать проект",
      },
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });
    const input = wrapper.get<HTMLElement>('[role="combobox"]');
    expect(input.attributes("id")).toBe("keyboard-project");
    expect(input.attributes("aria-label")).toBe("Выбрать проект");
    expect(input.attributes("tabindex")).toBe("0");
    input.element.focus();
    await input.trigger("keydown", { code: "ArrowDown", key: "ArrowDown" });
    await flushPromises();
    expect(input.attributes("aria-expanded")).toBe("true");
    const listId = input.attributes("aria-controls");
    expect(document.getElementById(listId!)?.getAttribute("role")).toBe(
      "listbox",
    );
    await input.trigger("keydown", { code: "ArrowDown", key: "ArrowDown" });
    await flushPromises();
    const activeId = input.attributes("aria-activedescendant");
    expect(document.getElementById(activeId!)?.textContent).toContain(
      options[1]!.detail,
    );
    await input.trigger("keydown", { code: "Enter", key: "Enter" });
    await flushPromises();
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["second"]);
    await vi.waitFor(() =>
      expect(input.attributes("aria-expanded")).toBe("false"),
    );
    await wrapper.setProps({ modelValue: "second" });
    await input.trigger("keydown", { code: "ArrowDown", key: "ArrowDown" });
    await flushPromises();
    expect(
      document.querySelector('[role="option"][aria-selected="true"]')
        ?.textContent,
    ).toContain(options[1]!.detail);
    const count = wrapper.emitted("update:modelValue")?.length;
    await input.trigger("keydown", { code: "Escape", key: "Escape" });
    await flushPromises();
    await vi.waitFor(() =>
      expect(input.attributes("aria-expanded")).toBe("false"),
    );
    expect(document.activeElement).toBe(input.element);
    expect(wrapper.emitted("update:modelValue")?.length).toBe(count);
    wrapper.unmount();
  });
});
