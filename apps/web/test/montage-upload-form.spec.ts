import { describe, expect, it } from "vitest";

import { validateMontageUpload } from "~/features/upload-montage-asset/model/montage-upload-form";

describe("montage upload validation", () => {
  it("accepts an MP4 only for a video montage material", () => {
    const result = validateMontageUpload({
      kind: "ADVERTISEMENT",
      file: new File(["video"], "ad.mp4", { type: "video/mp4" }),
    });
    expect(result).toMatchObject({ success: true });
  });

  it("keeps images out of the intro/outro/advertisement contract", () => {
    const result = validateMontageUpload({
      kind: "INTRO",
      file: new File(["image"], "intro.png", { type: "image/png" }),
    });
    expect(result).toEqual({
      success: false,
      errors: { file: "Для этого материала нужен MP4-файл." },
    });
  });

  it("accepts a PNG only as a banner and rejects a banner over its limit", () => {
    expect(
      validateMontageUpload({
        kind: "BANNER",
        file: new File(["image"], "banner.png", { type: "image/png" }),
      }),
    ).toMatchObject({ success: true });
    const tooLarge = new File(
      [new Uint8Array(10 * 1024 * 1024 + 1)],
      "banner.png",
      {
        type: "image/png",
      },
    );
    expect(validateMontageUpload({ kind: "BANNER", file: tooLarge })).toEqual({
      success: false,
      errors: { file: "Размер файла больше допустимого (10 МБ)." },
    });
  });
});
