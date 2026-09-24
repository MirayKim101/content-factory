import { describe, expect, it } from "vitest";

import { generateLocalNoLikenessThumbnail, inspectLocalThumbnailPng } from "../src/infrastructure/local-no-likeness-thumbnail-adapter.js";

describe("local no-likeness thumbnail adapter", () => {
  it("creates deterministic private-ready PNG bytes with honest zero-cost safety provenance", () => {
    const input = {
      candidateId: "00000000-0000-4000-8000-000000000001",
      seedFingerprint: "a".repeat(64),
    };
    const first = generateLocalNoLikenessThumbnail(input);
    const replay = generateLocalNoLikenessThumbnail(input);

    expect(first.bytes.subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect(first.bytes.readUInt32BE(16)).toBe(1280);
    expect(first.bytes.readUInt32BE(20)).toBe(720);
    expect(replay.candidate.sha256).toBe(first.candidate.sha256);
    expect(replay.bytes.equals(first.bytes)).toBe(true);
    expect(first.candidate).toMatchObject({
      contentType: "image/png",
      likeness: "NONE",
      sizeBytes: first.bytes.length,
    });
    expect(first.safetyDecision).toEqual({
      version: "no-likeness-safety-v1",
      realisticPersonRequested: false,
      referenceImageUsed: false,
      externalProviderUsed: false,
    });
    expect(first.directCostMicrousd).toBe(0);
  });

  it("changes the image identity when the exact context fingerprint changes", () => {
    const first = generateLocalNoLikenessThumbnail({
      candidateId: "00000000-0000-4000-8000-000000000001",
      seedFingerprint: "a".repeat(64),
    });
    const second = generateLocalNoLikenessThumbnail({
      candidateId: "00000000-0000-4000-8000-000000000002",
      seedFingerprint: "b".repeat(64),
    });
    expect(second.candidate.sha256).not.toBe(first.candidate.sha256);
  });

  it("rejects corrupted candidate bytes before they can become READY", () => {
    const output = generateLocalNoLikenessThumbnail({
      candidateId: "00000000-0000-4000-8000-000000000001",
      seedFingerprint: "a".repeat(64),
    });
    const corrupted = Buffer.from(output.bytes);
    corrupted[40] = corrupted[40]! ^ 1;
    expect(() => inspectLocalThumbnailPng(corrupted)).toThrow(
      "THUMBNAIL_PNG_CORRUPT",
    );
  });
});
