export function parseTimecode(value: string): number | null {
  const trimmed = value.trim();
  const seconds = /^(\d+)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (seconds) return boundedMilliseconds(Number(seconds[1]), seconds[2]);
  const clock = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!clock) return null;
  const totalSeconds =
    Number(clock[1]) * 3_600 + Number(clock[2]) * 60 + Number(clock[3]);
  return boundedMilliseconds(totalSeconds, clock[4]);
}

export function formatTimecode(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const fraction = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

function boundedMilliseconds(
  seconds: number,
  fraction: string | undefined,
): number | null {
  const value = seconds * 1_000 + Number((fraction ?? "").padEnd(3, "0") || 0);
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : null;
}
