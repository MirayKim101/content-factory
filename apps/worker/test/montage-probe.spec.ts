import { describe, expect, it } from "vitest";
import { parseMontageProbe } from "../src/domain/montage-probe.js";

const video = {
  codec_type: "video",
  codec_name: "h264",
  width: 1920,
  height: 1080,
  avg_frame_rate: "30/1",
  sample_aspect_ratio: "1:1",
  field_order: "progressive",
};
const probe = (stream = video) => ({
  format: {
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    duration: "3.0",
    tags: { major_brand: "isom" },
  },
  streams: [stream],
});
describe("versioned montage probe limits", () => {
  it("accepts supported silent H.264 MP4", () =>
    expect(parseMontageProbe(probe(), "test")).toEqual({
      schemaVersion: 1,
      width: 1920,
      height: 1080,
      durationMs: 3000,
      hasAudio: false,
      version: "test",
    }));
  it("accepts one stereo AAC track", () =>
    expect(
      parseMontageProbe(
        {
          ...probe(),
          streams: [
            video,
            {
              codec_type: "audio",
              codec_name: "aac",
              channels: 2,
              channel_layout: "stereo",
            },
          ],
        },
        "test",
      ).hasAudio,
    ).toBe(true));
  it.each([
    null,
    {},
    { ...probe(), format: { duration: "Infinity" } },
    { ...probe(), format: { format_name: "matroska", duration: "3" } },
    {
      ...probe(),
      format: { ...probe().format, tags: { major_brand: "qt" } },
    },
    { ...probe(), format: { ...probe().format, tags: {} } },
    { ...probe(), streams: [video, video] },
    { ...probe(), streams: [video, { codec_type: "subtitle" }] },
  ])("fails closed for invalid container/stream layout %#", (value) =>
    expect(() => parseMontageProbe(value, "test")).toThrow(
      "MONTAGE_MEDIA_UNSUPPORTED",
    ),
  );
  it.each([
    { codec_name: "hevc" },
    { width: 3841 },
    { height: 2161 },
    { avg_frame_rate: "61/1" },
    { avg_frame_rate: "1/0" },
    { sample_aspect_ratio: "2:1" },
    { tags: { rotate: "90" } },
    { side_data_list: [{ rotation: 90 }] },
    { field_order: "tt" },
  ])("rejects unsupported video %#", (patch) =>
    expect(() =>
      parseMontageProbe(probe({ ...video, ...patch }), "test"),
    ).toThrow("MONTAGE_MEDIA_UNSUPPORTED"),
  );
  it.each(["0", "180.001", "NaN"])("rejects duration %s", (duration) =>
    expect(() =>
      parseMontageProbe(
        { ...probe(), format: { ...probe().format, duration } },
        "test",
      ),
    ).toThrow("MONTAGE_MEDIA_UNSUPPORTED"),
  );
});
