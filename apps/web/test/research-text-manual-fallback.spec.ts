import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ResearchTextManualFallback from "~/widgets/editorial-package/ui/research-text-manual-fallback.vue";

describe("ResearchTextManualFallback", () => {
  it("keeps the manual metadata path explicit until a transcript intent is linked", () => {
    const wrapper = mount(ResearchTextManualFallback);

    expect(wrapper.get("section").attributes("aria-labelledby")).toBe(
      "research-text-manual-fallback-title",
    );
    expect(wrapper.get("h3").text()).toBe("Исследование и варианты текста");
    expect(wrapper.get('[role="status"]').text()).toContain(
      "research intent ещё не подключён",
    );
    expect(wrapper.text()).toContain("источники");
    expect(wrapper.findAll("button")).toHaveLength(0);
  });
});
