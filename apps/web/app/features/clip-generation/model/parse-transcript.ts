import type { ClipTranscriptCue } from "~/shared/api/clip-generation";

export class ClipTranscriptFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipTranscriptFormatError";
  }
}

const timestampLine =
  /^\s*(?:(\d{2,}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{2,}):)?(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$/;

export function parseClipTranscript(
  value: string,
  sourceDurationMs: number,
): ClipTranscriptCue[] {
  const blocks = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n/);
  const cues: ClipTranscriptCue[] = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const lines = block.split("\n").map((line) => line.trim());
    if (blockIndex === 0 && lines[0]?.startsWith("WEBVTT")) continue;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] ?? "")) continue;
    const timestampIndex = timestampLine.test(lines[0] ?? "")
      ? 0
      : timestampLine.test(lines[1] ?? "")
        ? 1
        : -1;
    if (timestampIndex < 0)
      throw new ClipTranscriptFormatError(
        "Найден повреждённый блок без корректных таймкодов.",
      );
    if (
      lines.slice(timestampIndex + 1).some((line) => timestampLine.test(line))
    )
      throw new ClipTranscriptFormatError(
        "Между cue должна быть пустая строка.",
      );
    const match = timestampLine.exec(lines[timestampIndex]!)!;
    const startMs = timestamp(match.slice(1, 5));
    const endMs = timestamp(match.slice(5, 9));
    const normalized = lines
      .slice(timestampIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    const previous = cues.at(-1);
    if (
      endMs <= startMs ||
      endMs > sourceDurationMs ||
      (previous && startMs < previous.endMs) ||
      !normalized ||
      normalized.length > 4_000
    )
      throw new ClipTranscriptFormatError(
        "Проверьте порядок, длительность и текст cue в транскрипте.",
      );
    cues.push({ startMs, endMs, text: normalized });
  }
  if (!cues.length)
    throw new ClipTranscriptFormatError(
      "Не найдены таймкоды SRT/VTT вида 00:00:05,000 --> 00:00:12,000.",
    );
  return cues;
}

function timestamp(parts: Array<string | undefined>): number {
  const hours = parts[0] === undefined ? 0 : Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);
  const milliseconds = Number(parts[3]);
  if (
    !Number.isSafeInteger(hours) ||
    !Number.isSafeInteger(minutes) ||
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(milliseconds) ||
    minutes > 59 ||
    seconds > 59
  )
    throw new ClipTranscriptFormatError("Некорректный таймкод транскрипта.");
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}
