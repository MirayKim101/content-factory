import type {
  ClipGenerationRequest,
  GeneratedClipSuggestion,
} from "@content-factory/contracts";

export type ClipGenerationResult = Readonly<{
  providerRequestId: string;
  model: string;
  suggestions: readonly GeneratedClipSuggestion[];
}>;

export interface ClipGenerationProvider {
  readonly provider: string;
  generate(
    request: ClipGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ClipGenerationResult>;
}
