import { describe, expect, it } from "vitest";

import {
  parseVerticalJobReference,
  VERTICAL_JOB_SCHEMA_VERSION,
  VERTICAL_OUTPUT,
} from "../src/vertical.js";

describe("vertical contract", () => {
  it("keeps exact 9:16 output and bounded queue pointers", () => {
    expect(VERTICAL_OUTPUT).toEqual({
      width: 1080,
      height: 1920,
      framingMode: "CENTER_CROP",
    });
    expect(
      parseVerticalJobReference({
        schemaVersion: VERTICAL_JOB_SCHEMA_VERSION,
        jobId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      schemaVersion: 1,
      jobId: "00000000-0000-4000-8000-000000000001",
    });
    expect(() =>
      parseVerticalJobReference({ schemaVersion: 1, jobId: "not-a-uuid" }),
    ).toThrow("VERTICAL_JOB_INVALID");
  });
});
