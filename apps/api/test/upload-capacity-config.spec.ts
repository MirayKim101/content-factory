import { describe, expect, it } from "vitest";

import {
  MAX_API_UPLOAD_BYTES,
  resolveUploadCapacityRuntime,
} from "../src/config/environment.js";

describe("upload capacity configuration", () => {
  it("rejects an API upload ceiling above the approved 10 GiB control-plane limit", () => {
    expect(() =>
      resolveUploadCapacityRuntime(
        {
          API_MAX_UPLOAD_BYTES: String(MAX_API_UPLOAD_BYTES + 1),
          API_UPLOAD_STAGING_SAFETY_BYTES: "0",
        },
        "other",
      ),
    ).toThrow("CONFIG_API_MAX_UPLOAD_BYTES_OUT_OF_RANGE");
  });

  it("requires an explicit nonnegative safety reservation outside local and test", () => {
    expect(() => resolveUploadCapacityRuntime({}, "other")).toThrow(
      "CONFIG_API_UPLOAD_STAGING_SAFETY_BYTES_REQUIRED",
    );
    expect(
      resolveUploadCapacityRuntime(
        { API_UPLOAD_STAGING_SAFETY_BYTES: "0" },
        "other",
      ),
    ).toEqual({
      maxUploadBytes: MAX_API_UPLOAD_BYTES,
      uploadStagingSafetyBytes: 0,
    });
  });
});
