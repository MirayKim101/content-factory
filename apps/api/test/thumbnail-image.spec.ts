import { describe, expect, it } from "vitest";

import {
  inspectThumbnail,
  ThumbnailValidationError,
} from "../src/editorial-content/domain/editorial.js";
import {
  jpeg,
  png,
  webp,
  webpExtendedLossless,
  webpLossless,
} from "./fixtures/thumbnail-fixture.js";

describe("thumbnail byte validation", () => {
  it("accepts JPEG, PNG, and WebP dimensions from bytes", () => {
    expect(inspectThumbnail(png(1200, 675), "image/png")).toMatchObject({
      contentType: "image/png",
      width: 1200,
      height: 675,
    });
    expect(inspectThumbnail(jpeg(), "image/jpeg")).toMatchObject({
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    });
    expect(inspectThumbnail(webp(), "image/webp")).toMatchObject({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    expect(inspectThumbnail(webpLossless(), "image/webp")).toMatchObject({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
    expect(
      inspectThumbnail(webpExtendedLossless(), "image/webp"),
    ).toMatchObject({
      contentType: "image/webp",
      width: 1,
      height: 1,
    });
  });

  it("rejects SVG, fake MIME, corrupt dimensions, and excessive pixels", () => {
    expect(() =>
      inspectThumbnail(Buffer.from("<svg></svg>"), "image/svg+xml"),
    ).toThrowError(
      expect.objectContaining({ code: "THUMBNAIL_FORMAT_UNSUPPORTED" }),
    );
    expect(() => inspectThumbnail(png(10, 10), "image/jpeg")).toThrowError(
      expect.objectContaining({ code: "THUMBNAIL_MIME_MISMATCH" }),
    );
    const corrupt = png(10, 10);
    corrupt[29] = corrupt[29]! ^ 0xff;
    expect(() => inspectThumbnail(corrupt, "image/png")).toThrowError(
      expect.objectContaining({ code: "THUMBNAIL_CORRUPT" }),
    );
    expect(() =>
      inspectThumbnail(png(10_000, 5_000), "image/png"),
    ).toThrowError(
      expect.objectContaining({ code: "THUMBNAIL_PIXEL_LIMIT_EXCEEDED" }),
    );
  });

  it("uses controlled validation errors", () => {
    try {
      inspectThumbnail(Buffer.alloc(1), "image/png");
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ThumbnailValidationError);
    }
  });

  it("rejects VP8L payloads with non-zero reserved version bits", () => {
    const reservedVersionBits = Buffer.from(
      "UklGRhoAAABXRUJQVlA4TAYAAAAvY8AY4ABKVU5LAAAAAA==",
      "base64",
    );

    expect(() =>
      inspectThumbnail(reservedVersionBits, "image/webp"),
    ).toThrowError(expect.objectContaining({ code: "THUMBNAIL_CORRUPT" }));
  });

  it("rejects VP8X payloads with non-zero reserved fields", () => {
    const reservedHeaderBytes = Buffer.from(
      "UklGRiwAAABXRUJQVlA4WAoAAAAAAQAAAAAAAAAAVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==",
      "base64",
    );
    const reservedFlagBits = Buffer.from(webpExtendedLossless());
    reservedFlagBits[20] = 0x80;

    for (const payload of [reservedHeaderBytes, reservedFlagBits]) {
      expect(() => inspectThumbnail(payload, "image/webp")).toThrowError(
        expect.objectContaining({ code: "THUMBNAIL_CORRUPT" }),
      );
    }
  });

  it("rejects complete-looking headers without decodable image payload structure", () => {
    const truncatedPng = png(10, 10).subarray(0, 33);
    expect(() => inspectThumbnail(truncatedPng, "image/png")).toThrowError(
      expect.objectContaining({ code: "THUMBNAIL_FORMAT_UNSUPPORTED" }),
    );

    const headerOnlyWebp = Buffer.alloc(30);
    headerOnlyWebp.write("RIFF", 0, "ascii");
    headerOnlyWebp.writeUInt32LE(22, 4);
    headerOnlyWebp.write("WEBP", 8, "ascii");
    headerOnlyWebp.write("VP8X", 12, "ascii");
    headerOnlyWebp.writeUInt32LE(10, 16);
    expect(() => inspectThumbnail(headerOnlyWebp, "image/webp")).toThrowError(
      expect.objectContaining({ code: "THUMBNAIL_CORRUPT" }),
    );

    const headerOnlyJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x00,
      0xff, 0xd9,
    ]);
    expect(() => inspectThumbnail(headerOnlyJpeg, "image/jpeg")).toThrowError(
      expect.objectContaining({ code: "THUMBNAIL_CORRUPT" }),
    );

    const fakeWebpFrame = Buffer.alloc(32);
    fakeWebpFrame.write("RIFF", 0, "ascii");
    fakeWebpFrame.writeUInt32LE(24, 4);
    fakeWebpFrame.write("WEBP", 8, "ascii");
    fakeWebpFrame.write("VP8 ", 12, "ascii");
    fakeWebpFrame.writeUInt32LE(11, 16);
    fakeWebpFrame.set([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a], 20);
    fakeWebpFrame.writeUInt16LE(1, 26);
    fakeWebpFrame.writeUInt16LE(1, 28);
    expect(() => inspectThumbnail(fakeWebpFrame, "image/webp")).toThrowError(
      expect.objectContaining({ code: "THUMBNAIL_CORRUPT" }),
    );
  });
});
