import { formatTimecode } from "~/shared/lib/timecode";

export { formatTimecode } from "~/shared/lib/timecode";

export interface SegmentDraft {
  clientKey: string;
  startText: string;
  endText: string;
}

export interface ValidSegment {
  clientSegmentId: string;
  startMs: number;
  endMs: number;
}

export function emptySegment(): SegmentDraft {
  return { clientKey: crypto.randomUUID(), startText: "", endText: "" };
}

export function segmentFromBounds(
  startMs: number,
  endMs: number,
): SegmentDraft {
  return {
    clientKey: crypto.randomUUID(),
    startText: formatTimecode(startMs),
    endText: formatTimecode(endMs),
  };
}

export function parseTimecode(value: string): number | null {
  const trimmed = value.trim();
  const parts = trimmed.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  const secondsPart = parts.at(-1);
  if (!secondsPart || !/^\d{1,2}(?:\.\d{1,3})?$/.test(secondsPart)) return null;
  const [secondsRaw = "", fraction = ""] = secondsPart.split(".");
  const seconds = Number(secondsRaw);
  if (seconds > 59) return null;
  const minutesRaw = parts.at(-2);
  if (!minutesRaw || !/^\d+$/.test(minutesRaw)) return null;
  const minutes = Number(minutesRaw);
  if (parts.length === 3 && minutes > 59) return null;
  const hoursRaw = parts.length === 3 ? parts[0] : "0";
  if (!hoursRaw || !/^\d+$/.test(hoursRaw)) return null;
  const hours = Number(hoursRaw);
  const milliseconds = fraction ? Number(fraction.padEnd(3, "0")) : 0;
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
  return Number.isSafeInteger(total) ? total : null;
}

export function validateSegments(
  drafts: SegmentDraft[],
  durationMs: number,
): { segments: ValidSegment[]; errors: Record<string, string> } {
  const segments: ValidSegment[] = [];
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (!draft.startText.trim() || !draft.endText.trim()) {
      errors[draft.clientKey] = "Укажите начало и конец отрезка.";
      continue;
    }
    const startMs = parseTimecode(draft.startText);
    const endMs = parseTimecode(draft.endText);
    if (startMs === null || endMs === null) {
      errors[draft.clientKey] = "Введите время, например 00:12:04.250.";
      continue;
    }
    if (startMs >= endMs) {
      errors[draft.clientKey] = "Конец должен быть позже начала.";
      continue;
    }
    if (endMs > durationMs) {
      errors[draft.clientKey] =
        `Конец выходит за длительность исходного видео (${formatTimecode(durationMs)}).`;
      continue;
    }
    const key = `${startMs}:${endMs}`;
    if (seen.has(key)) {
      errors[draft.clientKey] = "Этот отрезок уже добавлен.";
      continue;
    }
    seen.add(key);
    segments.push({ clientSegmentId: draft.clientKey, startMs, endMs });
  }
  return { segments, errors };
}
