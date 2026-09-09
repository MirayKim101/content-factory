import type { MontageProbeResultV1 } from "@content-factory/contracts";
import { ControlledMediaError } from "./media-job.js";

export function parseMontageProbe(
  value: unknown,
  version: string,
): MontageProbeResultV1 {
  if (!record(value) || !record(value.format) || !Array.isArray(value.streams))
    return invalid();
  const streams: Record<string, unknown>[] = [];
  for (const stream of value.streams) {
    if (!record(stream)) return invalid();
    streams.push(stream);
  }
  const videos = streams.filter((s) => s.codec_type === "video");
  const audio = streams.filter((s) => s.codec_type === "audio");
  const video = videos[0];
  const durationMs = Math.round(Number(value.format.duration) * 1000);
  const majorBrand = record(value.format.tags)
    ? String(value.format.tags.major_brand ?? "").trim()
    : "";
  if (
    typeof value.format.format_name !== "string" ||
    !value.format.format_name.split(",").includes("mp4") ||
    !isSupportedMp4Brand(majorBrand) ||
    videos.length !== 1 ||
    audio.length > 1 ||
    streams.length !== videos.length + audio.length ||
    !video ||
    video.codec_name !== "h264" ||
    audio.some((a) => a.codec_name !== "aac")
  )
    return invalid();
  const width = Number(video.width),
    height = Number(video.height);
  const frameRate = fraction(video.avg_frame_rate);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > 180000 ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 3840 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    height > 2160 ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0 ||
    frameRate > 60
  )
    return invalid();
  if (
    video.sample_aspect_ratio !== undefined &&
    video.sample_aspect_ratio !== "1:1" &&
    video.sample_aspect_ratio !== "N/A"
  )
    return invalid();
  if (
    video.field_order !== undefined &&
    !["progressive", "unknown"].includes(String(video.field_order))
  )
    return invalid();
  if (
    record(video.disposition) &&
    Number(video.disposition.attached_pic ?? 0) !== 0
  )
    return invalid();
  if (
    record(video.tags) &&
    video.tags.rotate !== undefined &&
    Number(video.tags.rotate) !== 0
  )
    return invalid();
  if (
    video.side_data_list !== undefined &&
    (!Array.isArray(video.side_data_list) || video.side_data_list.length !== 0)
  )
    return invalid();
  if (
    audio.some(
      (a) =>
        ![1, 2].includes(Number(a.channels)) ||
        !["mono", "stereo"].includes(String(a.channel_layout)),
    )
  )
    return invalid();
  return {
    schemaVersion: 1,
    durationMs,
    width,
    height,
    hasAudio: audio.length === 1,
    version,
  };
}
function isSupportedMp4Brand(value: string): boolean {
  return /^(?:isom|iso[2-9]|mp4[12]|avc1)$/i.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fraction(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(\/\d+)?$/.test(value)) return NaN;
  const [a, b = "1"] = value.split("/");
  return Number(a) / Number(b);
}
function invalid(): never {
  throw new ControlledMediaError(
    "MONTAGE_MEDIA_UNSUPPORTED",
    "MP4 must contain one H.264 video and at most one mono/stereo AAC audio, 1–180000 ms, ≤3840×2160 at ≤60 fps, without rotation or unsupported layout.",
    false,
  );
}
