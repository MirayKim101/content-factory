import { describe, expect, it } from "vitest";

import { nextMontageUploadProgress } from "~/features/upload-montage-asset/model/montage-upload-progress";

describe("montage upload progress", () => {
  it("is monotonic inside one request but a retry resets before its first progress event", () => {
    const firstAttempt = nextMontageUploadProgress(0, {
      loaded: 90,
      total: 100,
    });
    expect(firstAttempt).toBe(90);

    // The UI explicitly starts a new XHR with 0 after the first request fails.
    const retryStartsAt = 0;
    expect(
      nextMontageUploadProgress(retryStartsAt, { loaded: 10, total: 100 }),
    ).toBe(10);
  });
});
