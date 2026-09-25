import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";

import AppNavigation from "~/shared/ui/app-navigation.vue";

describe("AppNavigation mobile drawer", () => {
  beforeEach(() => {
    vi.stubGlobal("useRoute", () => reactive({ path: "/horizontal" }));
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        media: "(max-width: 1023px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps a closed drawer out of tab order and restores focus on Escape", async () => {
    const wrapper = mount(AppNavigation, {
      attachTo: document.body,
      global: {
        stubs: {
          NuxtLink: {
            props: ["to"],
            template: '<a href="#"><slot /></a>',
          },
        },
      },
    });
    await flushPromises();

    const sidebar = wrapper.get("#primary-navigation");
    expect(sidebar.attributes("inert")).toBeDefined();
    expect(sidebar.attributes("aria-hidden")).toBe("true");

    const toggle = wrapper.get<HTMLButtonElement>(".section-toggle");
    await toggle.trigger("click");
    await flushPromises();
    expect(sidebar.attributes("inert")).toBeUndefined();
    expect(document.activeElement).toBe(
      wrapper.get<HTMLButtonElement>(".drawer-close").element,
    );

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(sidebar.attributes("inert")).toBeDefined();
    expect(document.activeElement).toBe(toggle.element);

    await toggle.trigger("click");
    await flushPromises();
    await wrapper.findAll(".nav-group a")[1]!.trigger("click");
    await flushPromises();
    expect(sidebar.attributes("inert")).toBeDefined();
    expect(document.activeElement).toBe(toggle.element);

    wrapper.unmount();
  });

  it("wraps reverse Tab focus inside the open drawer", async () => {
    const wrapper = mount(AppNavigation, {
      attachTo: document.body,
      global: {
        stubs: {
          NuxtLink: {
            props: ["to"],
            template: '<a href="#"><slot /></a>',
          },
        },
      },
    });
    await wrapper.get(".section-toggle").trigger("click");
    await flushPromises();
    const focusable = wrapper
      .get("#primary-navigation")
      .findAll<HTMLElement>('button:not([disabled]), a[href]');
    focusable[0]!.element.focus();

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(focusable.at(-1)!.element);

    wrapper.unmount();
  });
});
