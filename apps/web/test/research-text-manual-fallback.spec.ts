import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import ResearchTextManualFallback from "~/features/research-text-suggestions/ui/research-text-manual-fallback.vue";

describe("ResearchTextManualFallback", () => {
  it("keeps the manual metadata path explicit until the research OpenAPI contract exists", () => {
    const wrapper = mount(ResearchTextManualFallback);

    expect(wrapper.get("section").attributes("aria-labelledby")).toBe(
      "research-text-manual-fallback-title",
    );
    expect(wrapper.get("h3").text()).toBe("Исследование и варианты текста");
    expect(wrapper.get('[role="status"]').text()).toContain(
      "Автоматические подсказки пока не подключены",
    );
    expect(wrapper.text()).toContain("источники");
    expect(wrapper.findAll("button")).toHaveLength(0);
  });
});
