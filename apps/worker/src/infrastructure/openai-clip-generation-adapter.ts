import {
  CLIP_GENERATION_CONTRACT_VERSION,
  validateClipGenerationRequest,
  validateGeneratedClipSuggestions,
  type ClipGenerationRequest,
  type GeneratedClipSuggestion,
} from "@content-factory/contracts";
import type {
  ClipGenerationProvider,
  ClipGenerationResult,
} from "../application/clip-generation-provider.port.js";

export const OPENAI_CLIP_PROMPT_VERSION = "openai-clip-selection-v1" as const;
type Fetch = typeof globalThis.fetch;

export class OpenAiClipGenerationAdapter implements ClipGenerationProvider {
  readonly provider = "OPENAI";
  constructor(
    private readonly config: {
      apiKey: string;
      model: string;
      timeoutMs: number;
      baseUrl?: string;
    },
    private readonly fetchImplementation: Fetch = globalThis.fetch,
  ) {}

  async generate(
    request: ClipGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ClipGenerationResult> {
    validateClipGenerationRequest(request);
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const response = await this.fetchImplementation(
      `${this.config.baseUrl ?? "https://api.openai.com"}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          store: false,
          instructions:
            "Select self-contained, high-retention clip intervals only from the supplied transcript. Never invent timestamps. Return editorial recommendations for human review, not publication decisions.",
          input: JSON.stringify({
            contractVersion: CLIP_GENERATION_CONTRACT_VERSION,
            promptVersion: OPENAI_CLIP_PROMPT_VERSION,
            ...request,
          }),
          text: {
            format: {
              type: "json_schema",
              name: "clip_suggestions",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["suggestions"],
                properties: {
                  suggestions: {
                    type: "array",
                    minItems: 1,
                    maxItems: request.maximumSuggestions,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "startMs",
                        "endMs",
                        "title",
                        "rationale",
                        "confidenceBasisPoints",
                      ],
                      properties: {
                        startMs: { type: "integer", minimum: 0 },
                        endMs: {
                          type: "integer",
                          minimum: 1,
                          maximum: request.sourceDurationMs,
                        },
                        title: { type: "string", minLength: 1, maxLength: 120 },
                        rationale: {
                          type: "string",
                          minLength: 1,
                          maxLength: 500,
                        },
                        confidenceBasisPoints: {
                          type: "integer",
                          minimum: 0,
                          maximum: 10_000,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    const payload = (await response.json()) as unknown;
    if (!response.ok) throw new Error(providerError(payload, response.status));
    return parseResponse(payload, request, this.config.model);
  }
}

function parseResponse(
  payload: unknown,
  request: ClipGenerationRequest,
  requestedModel: string,
): ClipGenerationResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("CLIP_GENERATION_PROVIDER_RESPONSE_INVALID");
  const value = payload as Record<string, unknown>;
  if (value.status !== "completed" || typeof value.id !== "string")
    throw new Error("CLIP_GENERATION_PROVIDER_INCOMPLETE");
  const output = Array.isArray(value.output) ? value.output : [];
  const content = output.flatMap((item) =>
    item &&
    typeof item === "object" &&
    Array.isArray((item as Record<string, unknown>).content)
      ? (item as { content: unknown[] }).content
      : [],
  );
  const item = content.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).type === "output_text" &&
      typeof (entry as Record<string, unknown>).text === "string",
  ) as Record<string, unknown> | undefined;
  if (!item) throw new Error("CLIP_GENERATION_PROVIDER_RESPONSE_INVALID");
  let decoded: unknown;
  try {
    decoded = JSON.parse(item.text as string);
  } catch {
    throw new Error("CLIP_GENERATION_PROVIDER_RESPONSE_INVALID");
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    !Array.isArray((decoded as Record<string, unknown>).suggestions)
  )
    throw new Error("CLIP_GENERATION_PROVIDER_RESPONSE_INVALID");
  const suggestions = (decoded as { suggestions: GeneratedClipSuggestion[] })
    .suggestions;
  validateGeneratedClipSuggestions(suggestions, request);
  return {
    providerRequestId: value.id,
    model: typeof value.model === "string" ? value.model : requestedModel,
    suggestions,
  };
}

function providerError(payload: unknown, status: number): string {
  const message =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { error?: { message?: unknown } }).error?.message
      : undefined;
  return `CLIP_GENERATION_PROVIDER_HTTP_${status}${typeof message === "string" ? `:${message.slice(0, 300)}` : ""}`;
}
