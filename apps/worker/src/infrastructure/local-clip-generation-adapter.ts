import { createHash } from "node:crypto";

import {
  CLIP_GENERATION_PROMPT_VERSIONS,
  validateClipGenerationRequest,
  validateGeneratedClipSuggestions,
  type ClipGenerationRequest,
  type GeneratedClipSuggestion,
} from "@content-factory/contracts";

import type {
  ClipGenerationProvider,
  ClipGenerationResult,
} from "../application/clip-generation-provider.port.js";

export const LOCAL_CLIP_PROMPT_VERSION =
  CLIP_GENERATION_PROMPT_VERSIONS.LOCAL_FIXTURE;

export class LocalClipGenerationAdapter implements ClipGenerationProvider {
  readonly provider = "LOCAL_FIXTURE";
  readonly promptVersion = LOCAL_CLIP_PROMPT_VERSION;

  constructor(readonly model = "local-deterministic-clip-v1") {}

  async generate(
    request: ClipGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ClipGenerationResult> {
    validateClipGenerationRequest(request);
    signal?.throwIfAborted();
    const suggestions: GeneratedClipSuggestion[] = [];
    const identities = new Set<string>();
    for (const cue of request.transcript) {
      const maximumEnd = Math.min(
        request.sourceDurationMs,
        cue.startMs + request.maximumClipDurationMs,
      );
      if (maximumEnd - cue.startMs < request.minimumClipDurationMs) continue;
      const endMs = Math.min(
        maximumEnd,
        Math.max(cue.endMs, cue.startMs + request.minimumClipDurationMs),
      );
      const identity = `${cue.startMs}:${endMs}`;
      if (identities.has(identity)) continue;
      identities.add(identity);
      suggestions.push({
        startMs: cue.startMs,
        endMs,
        title: cue.text.trim().replace(/\s+/g, " ").slice(0, 120),
        rationale:
          "Локальный deterministic fixture: интервал построен только для проверки workflow, без оценки качества.",
        confidenceBasisPoints: 0,
      });
      if (suggestions.length >= request.maximumSuggestions) break;
    }
    if (!suggestions.length)
      throw new Error("CLIP_GENERATION_LOCAL_FIXTURE_NO_VALID_INTERVAL");
    validateGeneratedClipSuggestions(suggestions, request);
    signal?.throwIfAborted();
    return {
      providerRequestId: `local-${createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex")}`,
      suggestions,
    };
  }
}
