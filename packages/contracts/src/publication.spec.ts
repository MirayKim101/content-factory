import { describe, expect, it } from "vitest";

import {
  canTransitionPublication,
  isTerminalPublicationState,
  parsePublicationJobReference,
  requirePublicationSchedule,
} from "./publication.js";

describe("publication contracts", () => {
  it("accepts only the bounded v1 queue pointer", () => {
    expect(
      parsePublicationJobReference({
        schemaVersion: 1,
        publicationIntentId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ schemaVersion: 1 });
    expect(() =>
      parsePublicationJobReference({
        schemaVersion: 2,
        publicationIntentId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("PUBLICATION_JOB_PAYLOAD_INVALID");
  });

  it("keeps remote uncertainty non-terminal and terminal states immutable", () => {
    expect(canTransitionPublication("PROCESSING", "UNKNOWN_REMOTE_STATE")).toBe(
      true,
    );
    expect(canTransitionPublication("UNKNOWN_REMOTE_STATE", "PUBLISHED")).toBe(
      true,
    );
    expect(canTransitionPublication("PUBLISHED", "PROCESSING")).toBe(false);
    expect(isTerminalPublicationState("UNKNOWN_REMOTE_STATE")).toBe(false);
    expect(isTerminalPublicationState("DRY_RUN_READY")).toBe(true);
  });

  it("canonicalizes future UTC schedules and rejects past instants", () => {
    const now = new Date("2026-09-27T12:00:00.000Z");
    expect(requirePublicationSchedule("2026-09-27T13:00:00+00:00", now)).toBe(
      "2026-09-27T13:00:00.000Z",
    );
    expect(() =>
      requirePublicationSchedule("2026-09-27T11:59:59.999Z", now),
    ).toThrow("PUBLICATION_SCHEDULE_INVALID");
  });

  it.each([
    "2026-09-27",
    "2026-09-27T13:00:00",
    "2026-09-27 13:00:00Z",
    "2026-09-27T13:00Z",
  ])("rejects a schedule without an explicit RFC3339 offset: %s", (value) => {
    expect(() =>
      requirePublicationSchedule(value, new Date("2026-09-27T12:00:00.000Z")),
    ).toThrow("PUBLICATION_SCHEDULE_INVALID");
  });
});
