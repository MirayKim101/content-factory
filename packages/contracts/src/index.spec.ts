import { describe, expect, it } from "vitest";

import { parseMediaJobReference } from "./index.js";

describe("MediaJobReferenceV1", () => {
  it("accepts the versioned reference-only payload", () => {
    expect(
      parseMediaJobReference({
        schemaVersion: 1,
        jobId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      schemaVersion: 1,
      jobId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects unknown versions and embedded work details", () => {
    expect(() =>
      parseMediaJobReference({
        schemaVersion: 2,
        jobId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("JOB_PAYLOAD_INVALID");
  });
});
