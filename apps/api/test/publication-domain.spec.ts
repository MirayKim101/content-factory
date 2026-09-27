import { describe, expect, it } from "vitest";

import {
  PublicationMetadataInvalidError,
  requirePublicationExternalChannelRef,
} from "../src/publishing/domain/publication.js";

describe("publication channel identity", () => {
  it("accepts an opaque TikTok open_id without treating a display name as identity", () => {
    expect(
      requirePublicationExternalChannelRef(
        "TIKTOK",
        "723f24d7-e717-40f8-a2b6-cb8464cd23b4",
      ),
    ).toBe("723f24d7-e717-40f8-a2b6-cb8464cd23b4");
  });

  it.each([
    "@display-name",
    "https://tiktok.com/@creator",
    "open id",
    "x".repeat(129),
  ])("rejects mutable or malformed TikTok identity %s", (value) => {
    expect(() => requirePublicationExternalChannelRef("TIKTOK", value)).toThrow(
      PublicationMetadataInvalidError,
    );
  });
});
