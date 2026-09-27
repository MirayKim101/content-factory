import { describe, expect, it } from "vitest";

import { hasBlockingVerticalRender } from "~/widgets/vertical-workspace/model/availability";

function render(state: "QUEUED" | "READY" | "FAILED_FINAL") {
  return {
    cutPipelineJobId: "cut-1",
    job: { state },
  };
}

describe("vertical render availability", () => {
  it("blocks duplicate active and ready renders", () => {
    expect(hasBlockingVerticalRender("cut-1", [render("QUEUED")])).toBe(true);
    expect(hasBlockingVerticalRender("cut-1", [render("READY")])).toBe(true);
  });

  it("allows a fresh audited attempt after final failure", () => {
    expect(hasBlockingVerticalRender("cut-1", [render("FAILED_FINAL")])).toBe(
      false,
    );
    expect(hasBlockingVerticalRender("cut-2", [render("READY")])).toBe(false);
  });
});
