export function formatTimecode(milliseconds: number): string {
  const safe = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const fraction = safe % 1_000;
  const wholeSeconds = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return fraction
    ? `${wholeSeconds}.${String(fraction).padStart(3, "0")}`
    : wholeSeconds;
}

/** Presentation-only rounding. API payloads and editable timecode strings retain milliseconds. */
export function formatDisplayTimecode(milliseconds: number): string {
  const safe = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const seconds = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
