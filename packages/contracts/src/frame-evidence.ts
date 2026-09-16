/** Frozen deterministic sampling contract. No storage keys belong in public DTOs. */
export const FRAME_EVIDENCE_CONTRACT = "editorial-sparse-frames-v1" as const;
export const FRAME_EXTRACTOR_VERSION = "ffmpeg-frame-extractor-v1" as const;
export const FRAME_EXTRACTION_RECIPE = "quartiles-jpeg-640-v1" as const;
export const FRAME_PROGRESS_SCHEMA = "editorial-frame-progress-v1" as const;
export const FRAME_RESOURCE_CLASS = "FRAME_EXTRACTION" as const;
export const FRAME_LIMITS = Object.freeze({
  count: 3,
  maxDurationMs: 600_000,
  maxInputBytes: 512 * 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
  maxSetBytes: 12 * 1024 * 1024,
  maxDimension: 640,
  timeBaseNumerator: 1,
  timeBaseDenominator: 1_000_000,
  defaultWorkDeadlineMs: 300_000,
  minWorkDeadlineMs: 60_000,
  killGraceMs: 10_000,
  reclaimGraceMs: 30_000,
});

export type FrameProgressPhase =
  "READ_INPUT" | "EXTRACT" | "HASH" | "UPLOAD" | "FINALIZE";

export interface FrameMeasurement {
  ordinal: number;
  requestedCutMs: number;
  requestedSourceMs: number;
  actualPtsTicks: number;
  timeBaseNumerator: 1;
  timeBaseDenominator: 1_000_000;
  actualCutMs: number;
  mappedSourceMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  contentType: "image/jpeg";
  recipeVersion: typeof FRAME_EXTRACTION_RECIPE;
  extractorVersion: typeof FRAME_EXTRACTOR_VERSION;
  ffmpegVersion: string;
}

export function frameRequestedPositions(
  startMs: number,
  endMs: number,
  inputSizeBytes: number,
): readonly [number, number, number] {
  const duration = endMs - startMs;
  if (
    !Number.isSafeInteger(startMs) ||
    startMs < 0 ||
    !Number.isSafeInteger(endMs) ||
    duration <= 0 ||
    duration > FRAME_LIMITS.maxDurationMs ||
    !Number.isSafeInteger(inputSizeBytes) ||
    inputSizeBytes <= 0 ||
    inputSizeBytes > FRAME_LIMITS.maxInputBytes
  )
    throw new Error("FRAME_INPUT_UNSUPPORTED");
  const positions = [
    Math.floor(duration / 4),
    Math.floor(duration / 2),
    Math.floor((3 * duration) / 4),
  ] as const;
  if (
    positions[0] < 0 ||
    positions[0] >= positions[1] ||
    positions[1] >= positions[2] ||
    positions[2] >= duration
  ) {
    throw new Error("FRAME_INPUT_UNSUPPORTED");
  }
  return positions;
}

export function validateFrameMeasurements(
  frames: readonly FrameMeasurement[],
  requestedPositions: readonly number[],
  startMs: number,
  presentationDurationTicks: number,
): void {
  if (
    frames.length !== FRAME_LIMITS.count ||
    requestedPositions.length !== FRAME_LIMITS.count ||
    !Number.isSafeInteger(presentationDurationTicks) ||
    presentationDurationTicks <= 0
  ) {
    throw new Error("FRAME_TIMING_UNSUPPORTED");
  }
  let totalBytes = 0;
  let previousTicks = -1;
  for (const [ordinal, frame] of frames.entries()) {
    const requested = requestedPositions[ordinal];
    if (
      requested === undefined ||
      frame.ordinal !== ordinal ||
      frame.requestedCutMs !== requested ||
      frame.requestedSourceMs !== startMs + requested ||
      !Number.isSafeInteger(frame.actualPtsTicks) ||
      frame.actualPtsTicks < requested * 1000 ||
      frame.actualPtsTicks <= previousTicks ||
      frame.actualPtsTicks >= presentationDurationTicks ||
      frame.timeBaseNumerator !== 1 ||
      frame.timeBaseDenominator !== 1_000_000 ||
      frame.actualCutMs !== frame.actualPtsTicks / 1000 ||
      frame.mappedSourceMs !== startMs + frame.actualPtsTicks / 1000
    ) {
      throw new Error("FRAME_TIMING_UNSUPPORTED");
    }
    if (
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width <= 0 ||
      frame.height <= 0 ||
      Math.max(frame.width, frame.height) > FRAME_LIMITS.maxDimension ||
      !Number.isSafeInteger(frame.sizeBytes) ||
      frame.sizeBytes <= 0 ||
      frame.sizeBytes > FRAME_LIMITS.maxFrameBytes ||
      !/^[0-9a-f]{64}$/.test(frame.sha256) ||
      frame.contentType !== "image/jpeg" ||
      frame.recipeVersion !== FRAME_EXTRACTION_RECIPE ||
      frame.extractorVersion !== FRAME_EXTRACTOR_VERSION ||
      !frame.ffmpegVersion
    ) {
      throw new Error("FRAME_OUTPUT_INVALID");
    }
    previousTicks = frame.actualPtsTicks;
    totalBytes += frame.sizeBytes;
  }
  if (totalBytes > FRAME_LIMITS.maxSetBytes)
    throw new Error("FRAME_OUTPUT_INVALID");
}
