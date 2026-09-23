import { describe, expect, it } from "vitest";
import {
  THUMBNAIL_CONTRACT_VERSION,
  validateThumbnailCandidate,
} from "@content-factory/contracts";

describe("thumbnail candidate contract", () => {
  it("requires private artifact provenance and checksum", () => {
    const candidate = {
      id: "candidate",
      contractVersion: THUMBNAIL_CONTRACT_VERSION,
      adapterVersion: "local-thumbnail-v1",
      promptBasisVersion: "manual-basis-v1",
      contentType: "image/png" as const,
      sizeBytes: 10,
      sha256: "a".repeat(64),
      likeness: "NONE" as const,
    };
    expect(() => validateThumbnailCandidate(candidate)).not.toThrow();
    expect(() => validateThumbnailCandidate({ ...candidate, sha256: "bad" })).toThrow(
      "THUMBNAIL_CHECKSUM_INVALID",
    );
  });
});
