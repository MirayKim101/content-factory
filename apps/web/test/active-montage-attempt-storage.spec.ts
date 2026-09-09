import { describe, expect, it } from "vitest";

import {
  clearActiveMontageAttempt,
  loadActiveMontageAttempt,
  matchesMontageAttempt,
  saveActiveMontageAttempt,
} from "~/features/upload-montage-asset/model/active-montage-attempt-storage";

const projectId = "00000000-0000-4000-8000-000000000001";
const file = () =>
  new File(["video"], "advertisement.mp4", {
    type: "video/mp4",
    lastModified: 1_700_000_000_000,
  });

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("active montage upload attempt storage", () => {
  it("reconstructs the same idempotency key after reload when the same file is reselected", () => {
    const local = storage();
    saveActiveMontageAttempt(
      {
        projectId,
        kind: "ADVERTISEMENT",
        idempotencyKey: "web-montage-retry-key",
        fingerprint: {
          name: "advertisement.mp4",
          size: 5,
          lastModified: 1_700_000_000_000,
          type: "video/mp4",
        },
      },
      local,
    );

    // This is the reconstructed browser state after a full page reload: the
    // File itself cannot be persisted, so the user selects it again.
    const restored = loadActiveMontageAttempt(local);
    expect(restored?.idempotencyKey).toBe("web-montage-retry-key");
    expect(
      restored &&
        matchesMontageAttempt(restored, projectId, "ADVERTISEMENT", file()),
    ).toBe(true);
  });

  it("does not match a changed file and clears only when instructed", () => {
    const local = storage();
    saveActiveMontageAttempt(
      {
        projectId,
        kind: "INTRO",
        idempotencyKey: "web-montage-retry-key",
        fingerprint: {
          name: "intro.mp4",
          size: 1,
          lastModified: 1,
          type: "video/mp4",
        },
      },
      local,
    );
    const attempt = loadActiveMontageAttempt(local)!;
    expect(matchesMontageAttempt(attempt, projectId, "INTRO", file())).toBe(
      false,
    );
    expect(loadActiveMontageAttempt(local)).not.toBeNull();
    clearActiveMontageAttempt(local);
    expect(loadActiveMontageAttempt(local)).toBeNull();
  });
});
