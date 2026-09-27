import { describe, expect, it } from "vitest";

import {
  hasActiveVerticalRender,
  hasBlockingVerticalRender,
} from "~/widgets/vertical-workspace/model/availability";

function render(
  state: "QUEUED" | "PROCESSING" | "RETRY_WAIT" | "READY" | "FAILED_FINAL",
) {
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

  it("polls while a render can still change state", () => {
    expect(hasActiveVerticalRender([render("QUEUED")])).toBe(true);
    expect(hasActiveVerticalRender([render("PROCESSING")])).toBe(true);
    expect(hasActiveVerticalRender([render("RETRY_WAIT")])).toBe(true);
  });

  it("stops polling after every render reaches a terminal state", () => {
    expect(
      hasActiveVerticalRender([render("READY"), render("FAILED_FINAL")]),
    ).toBe(false);
  });
});
