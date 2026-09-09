import { describe, expect, it } from "vitest";

import {
  createAssemblyRecipePayload,
  emptyAssemblyRecipeForm,
  parseWholeSecondTime,
} from "~/features/edit-assembly-recipe/model/assembly-recipe-form";
import { idempotencyForAssemblyRecipeSave } from "~/features/edit-assembly-recipe/model/save-identity";

const ids = {
  intro: "00000000-0000-4000-8000-000000000001",
  outro: "00000000-0000-4000-8000-000000000002",
  ad: "00000000-0000-4000-8000-000000000003",
  banner: "00000000-0000-4000-8000-000000000004",
};
const assets = Object.entries(ids).map(([name, id]) => ({
  id,
  projectId: "00000000-0000-4000-8000-000000000010",
  sourceId: "00000000-0000-4000-8000-000000000011",
  sourceVersion: 1,
  kind: (
    {
      intro: "INTRO",
      outro: "OUTRO",
      ad: "ADVERTISEMENT",
      banner: "BANNER",
    } as const
  )[name]!,
  status: "READY" as const,
  revision: 1,
  originalFilename: `${name}.mp4`,
  contentType: "video/mp4" as const,
  sizeBytes: "1",
  sha256: "a".repeat(64),
  width: 1,
  height: 1,
  durationMs: 1_000,
  hasAudio: false,
  probeJobId: null,
  probe: null,
  failure: null,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
}));

describe("assembly recipe form", () => {
  it("accepts only visible HH:MM:SS and converts it to exact milliseconds", () => {
    expect(parseWholeSecondTime("01:02:03")).toBe(3_723_000);
    expect(parseWholeSecondTime("00:60:00")).toBeUndefined();
    expect(parseWholeSecondTime("00:00:01.500")).toBeUndefined();
  });

  it("builds the complete API payload with correct kind-filtered assets", () => {
    const form = emptyAssemblyRecipeForm();
    form.introAssetId = ids.intro;
    form.outroAssetId = ids.outro;
    form.advertisementAssetId = ids.ad;
    form.advertisementInsertAtText = "00:10:00";
    form.banners.push({
      clientItemId: "banner-1",
      assetId: ids.banner,
      startText: "00:00:30",
      endText: "00:00:45",
      position: "TOP_RIGHT",
    });
    form.ctaText = "Смотрите стрим";
    form.ctaStartText = "00:01:00";
    form.ctaEndText = "00:01:15";
    const result = createAssemblyRecipePayload(form, 2, 1_800_000, assets);
    expect(result.error).toBeUndefined();
    expect(result.payload).toMatchObject({
      expectedRevision: 2,
      introAssetId: ids.intro,
      outroAssetId: ids.outro,
      advertisement: { assetId: ids.ad, insertAtMs: 600_000 },
      banners: [{ assetId: ids.banner, startMs: 30_000, endMs: 45_000 }],
      cta: { text: "Смотрите стрим", startMs: 60_000, endMs: 75_000 },
    });
  });

  it("preserves a loaded non-whole-second timeline until its visible value changes", () => {
    const form = emptyAssemblyRecipeForm();
    form.advertisementAssetId = ids.ad;
    form.advertisementInsertAtText = "00:00:02";
    form.advertisementInsertAtBaselineText = "00:00:02";
    form.advertisementInsertAtBaselineMs = 1_500;
    form.banners.push({
      clientItemId: "banner-precise",
      assetId: ids.banner,
      startText: "00:00:02",
      endText: "00:00:04",
      startBaselineText: "00:00:02",
      startBaselineMs: 1_500,
      endBaselineText: "00:00:04",
      endBaselineMs: 4_500,
      position: "TOP_RIGHT",
    });
    form.ctaText = "CTA";
    form.ctaStartText = "00:00:06";
    form.ctaEndText = "00:00:08";
    form.ctaStartBaselineText = "00:00:06";
    form.ctaStartBaselineMs = 5_500;
    form.ctaEndBaselineText = "00:00:08";
    form.ctaEndBaselineMs = 8_500;
    const noOp = createAssemblyRecipePayload(form, 1, 60_000, assets).payload!;
    expect(noOp.advertisement?.insertAtMs).toBe(1_500);
    expect(noOp.banners[0]).toMatchObject({ startMs: 1_500, endMs: 4_500 });
    expect(noOp.cta).toMatchObject({ startMs: 5_500, endMs: 8_500 });

    form.advertisementInsertAtText = "00:00:03";
    form.banners[0]!.endText = "00:00:05";
    form.ctaStartText = "00:00:07";
    const edited = createAssemblyRecipePayload(
      form,
      1,
      60_000,
      assets,
    ).payload!;
    expect(edited.advertisement?.insertAtMs).toBe(3_000);
    expect(edited.banners[0]?.endMs).toBe(5_000);
    expect(edited.cta?.startMs).toBe(7_000);
  });

  it("rejects a wrong asset kind and an invalid cut-local interval", () => {
    const form = emptyAssemblyRecipeForm();
    form.advertisementAssetId = ids.banner;
    form.advertisementInsertAtText = "00:00:00";
    expect(
      createAssemblyRecipePayload(form, 0, 60_000, assets).error,
    ).toContain("Реклама");
  });

  it("reuses a durable key only for the exact retry payload", () => {
    const body = {
      expectedRevision: 0,
      introAssetId: null,
      outroAssetId: null,
      advertisement: null,
      banners: [],
      cta: null,
      audioProfileVersion: "youtube-stereo-v1" as const,
      encodingProfileVersion: "youtube-h264-v1" as const,
    };
    const first = idempotencyForAssemblyRecipeSave(
      undefined,
      body,
      () => "first",
    );
    expect(
      idempotencyForAssemblyRecipeSave(first, body, () => "second"),
    ).toEqual(first);
    expect(
      idempotencyForAssemblyRecipeSave(
        first,
        { ...body, expectedRevision: 1 },
        () => "second",
      ).key,
    ).toBe("second");
  });
});
