import { describe, expect, it } from "vitest";

import type { TwitchVodCandidate } from "~/shared/api/twitch-sources";
import { hasActiveTwitchImport } from "~/widgets/twitch-sources-workspace/model/status";

function candidate(
  state:
    | "QUEUED"
    | "DOWNLOADING"
    | "UPLOADING"
    | "RETRY_WAIT"
    | "READY"
    | "FAILED_FINAL"
    | "CANCELED",
): TwitchVodCandidate {
  return {
    ingestIntent: { state },
  } as TwitchVodCandidate;
}

describe("Twitch import status", () => {
  it.each(["QUEUED", "DOWNLOADING", "UPLOADING", "RETRY_WAIT"] as const)(
    "keeps polling while an import is %s",
    (state) => {
      expect(hasActiveTwitchImport([candidate(state)])).toBe(true);
    },
  );

  it("stops polling when every import is terminal", () => {
    expect(
      hasActiveTwitchImport([
        candidate("READY"),
        candidate("FAILED_FINAL"),
        candidate("CANCELED"),
      ]),
    ).toBe(false);
  });
});
