import { describe, expect, it } from "vitest";

import { publicationRetryAt } from "../src/infrastructure/pg-publication-worker.repository.js";

describe("publicationRetryAt", () => {
  const now = new Date("2026-09-29T08:00:00.000Z");

  it.each([
    [1, "2026-09-29T08:00:30.000Z"],
    [2, "2026-09-29T08:01:00.000Z"],
    [3, "2026-09-29T08:02:00.000Z"],
    [10, "2026-09-29T08:15:00.000Z"],
  ])("backs off attempt %i to %s", (attempt, expected) => {
    expect(publicationRetryAt(now, attempt).toISOString()).toBe(expected);
  });

  it("rejects invalid attempt numbers", () => {
    expect(() => publicationRetryAt(now, 0)).toThrow(
      "PUBLICATION_ATTEMPT_NUMBER_INVALID",
    );
  });
});
