import { z } from "zod";

import { parseApiBasePath } from "~/shared/config/api-config";

const suggestionSchema = z.object({
  id: z.uuid(),
  ordinal: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  title: z.string(),
  rationale: z.string(),
  confidenceBasisPoints: z.number().int().min(0).max(10_000),
});
const intentSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  state: z.enum(["QUEUED", "PROCESSING", "READY", "FAILED_FINAL"]),
  provider: z.string(),
  model: z.string(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.union([z.iso.datetime(), z.date()]).transform(String),
  updatedAt: z.union([z.iso.datetime(), z.date()]).transform(String),
  suggestions: z.array(suggestionSchema),
});
const listSchema = z.object({
  items: z.array(intentSchema),
  // A previous API may omit capabilities; do not enable writes by assumption.
  generationEnabled: z.boolean().optional().default(false),
});
const cutResponseSchema = z.object({
  requestId: z.uuid(),
  projectId: z.uuid(),
  jobs: z.array(z.object({ id: z.uuid() }).passthrough()),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export type ClipGenerationIntent = z.infer<typeof intentSchema>;
export type ClipTranscriptCue = {
  startMs: number;
  endMs: number;
  text: string;
};

export class ClipGenerationApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ClipGenerationApiError";
  }
}

export function createClipGenerationApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    create(input: {
      projectId: string;
      idempotencyKey: string;
      sourceTitle: string;
      transcript: ClipTranscriptCue[];
      maximumSuggestions: number;
      minimumClipDurationMs: number;
      maximumClipDurationMs: number;
      language: string;
      externalProviderTransferAllowed: boolean;
    }) {
      return request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(input.projectId)}/clip-generations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            sourceTitle: input.sourceTitle,
            transcript: input.transcript,
            maximumSuggestions: input.maximumSuggestions,
            minimumClipDurationMs: input.minimumClipDurationMs,
            maximumClipDurationMs: input.maximumClipDurationMs,
            language: input.language,
            externalProviderTransferAllowed:
              input.externalProviderTransferAllowed,
          }),
        },
        intentSchema,
      );
    },
    list(projectId: string) {
      return request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/clip-generations`,
        {},
        listSchema,
      );
    },
    accept(input: {
      intentId: string;
      suggestionIds: string[];
      idempotencyKey: string;
    }) {
      return request(
        fetchImplementation,
        `${basePath}/clip-generations/${encodeURIComponent(input.intentId)}/accept`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({ suggestionIds: input.suggestionIds }),
        },
        cutResponseSchema,
      );
    },
  };
}

async function request<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new ClipGenerationApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API.",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = errorSchema.safeParse(payload);
    throw new ClipGenerationApiError(
      error.success ? error.data.error.code : "API_RESPONSE_INVALID",
      error.success
        ? error.data.error.message
        : "Сервер вернул некорректный ответ.",
      response.status,
    );
  }
  return schema.parse(payload);
}
