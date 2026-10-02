export const CLIP_GENERATION_CONTRACT_VERSION = "clip-generation-v1" as const;
export const CLIP_GENERATION_PROMPT_VERSIONS = {
  OPENAI: "openai-clip-selection-v1",
  LOCAL_FIXTURE: "local-deterministic-clip-v1",
} as const;

export type ClipTranscriptCue = Readonly<{
  startMs: number;
  endMs: number;
  text: string;
}>;
export type GeneratedClipSuggestion = Readonly<{
  startMs: number;
  endMs: number;
  title: string;
  rationale: string;
  confidenceBasisPoints: number;
}>;
export type ClipGenerationRequest = Readonly<{
  sourceDurationMs: number;
  sourceTitle: string;
  transcript: readonly ClipTranscriptCue[];
  maximumSuggestions: number;
  minimumClipDurationMs: number;
  maximumClipDurationMs: number;
  language: string;
}>;

export function validateClipGenerationRequest(
  input: ClipGenerationRequest,
): void {
  if (
    !Number.isSafeInteger(input.sourceDurationMs) ||
    input.sourceDurationMs < 1
  )
    throw new Error("CLIP_GENERATION_SOURCE_DURATION_INVALID");
  if (!input.sourceTitle.trim() || input.sourceTitle.length > 300)
    throw new Error("CLIP_GENERATION_SOURCE_TITLE_INVALID");
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(input.language))
    throw new Error("CLIP_GENERATION_LANGUAGE_INVALID");
  if (
    !Number.isSafeInteger(input.maximumSuggestions) ||
    input.maximumSuggestions < 1 ||
    input.maximumSuggestions > 20
  )
    throw new Error("CLIP_GENERATION_COUNT_INVALID");
  if (
    !Number.isSafeInteger(input.minimumClipDurationMs) ||
    !Number.isSafeInteger(input.maximumClipDurationMs) ||
    input.minimumClipDurationMs < 5_000 ||
    input.maximumClipDurationMs > 600_000 ||
    input.minimumClipDurationMs > input.maximumClipDurationMs
  )
    throw new Error("CLIP_GENERATION_DURATION_RANGE_INVALID");
  if (!input.transcript.length || input.transcript.length > 10_000)
    throw new Error("CLIP_GENERATION_TRANSCRIPT_INVALID");
  let previousEndMs = 0;
  for (const cue of input.transcript) {
    if (
      !Number.isSafeInteger(cue.startMs) ||
      !Number.isSafeInteger(cue.endMs) ||
      cue.startMs < previousEndMs ||
      cue.endMs <= cue.startMs ||
      cue.endMs > input.sourceDurationMs ||
      !cue.text.trim() ||
      cue.text.length > 4_000
    )
      throw new Error("CLIP_GENERATION_TRANSCRIPT_INVALID");
    previousEndMs = cue.endMs;
  }
}

export function validateGeneratedClipSuggestions(
  suggestions: readonly GeneratedClipSuggestion[],
  request: ClipGenerationRequest,
): void {
  if (!suggestions.length || suggestions.length > request.maximumSuggestions)
    throw new Error("CLIP_GENERATION_OUTPUT_INVALID");
  for (const suggestion of suggestions) {
    const durationMs = suggestion.endMs - suggestion.startMs;
    if (
      !Number.isSafeInteger(suggestion.startMs) ||
      !Number.isSafeInteger(suggestion.endMs) ||
      suggestion.startMs < 0 ||
      suggestion.endMs > request.sourceDurationMs ||
      durationMs < request.minimumClipDurationMs ||
      durationMs > request.maximumClipDurationMs ||
      !suggestion.title.trim() ||
      suggestion.title.length > 120 ||
      !suggestion.rationale.trim() ||
      suggestion.rationale.length > 500 ||
      !Number.isSafeInteger(suggestion.confidenceBasisPoints) ||
      suggestion.confidenceBasisPoints < 0 ||
      suggestion.confidenceBasisPoints > 10_000
    )
      throw new Error("CLIP_GENERATION_OUTPUT_INVALID");
  }
}
