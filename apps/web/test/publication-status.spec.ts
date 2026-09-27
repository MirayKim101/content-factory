import { describe, expect, it } from "vitest";

import type { PublicationIntent } from "~/shared/api/publications";
import { hasPendingPublication } from "~/widgets/publication-workspace/model/status";

function publication(state: PublicationIntent["state"]) {
  return { state };
}

describe("publication polling status", () => {
  it.each(["SCHEDULED", "QUEUED", "PROCESSING"] as const)(
    "keeps polling while a publication is %s",
    (state) => {
      expect(hasPendingPublication([publication(state)])).toBe(true);
    },
  );

  it("stops polling when every publication requires no automatic transition", () => {
    expect(
      hasPendingPublication([
        publication("DRY_RUN_READY"),
        publication("PUBLISHED"),
        publication("UNKNOWN_REMOTE_STATE"),
        publication("FAILED_FINAL"),
        publication("CANCELED"),
      ]),
    ).toBe(false);
  });
});
