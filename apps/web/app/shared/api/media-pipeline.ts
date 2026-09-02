import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type PipelineJob = components["schemas"]["PipelineJobResponseDto"];
export type CreateCutsResponse = components["schemas"]["CreateCutsResponseDto"];

const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
const pipelineJobSchema: z.ZodType<PipelineJob> = z.object({
  id: z.uuid(),
  clientSegmentId: z.uuid(),
  revision: z.number().int().positive(),
  state: z.enum([
    "QUEUED",
    "PROCESSING",
    "RETRY_WAIT",
    "READY",
    "FAILED_FINAL",
  ]),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  processedMs: z.number().int().nonnegative().optional(),
  totalMs: z.number().int().positive().optional(),
  attempt: z.number().int().nonnegative(),
  retryBudget: z.number().int().nonnegative(),
  failure: failureSchema.optional(),
  result: z
    .object({
      filename: z.string(),
      sizeBytes: z.string().regex(/^\d+$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      downloadUrl: z.string(),
    })
    .optional(),
  updatedAt: z.iso.datetime(),
});

const createCutsResponseSchema: z.ZodType<CreateCutsResponse> = z.object({
  requestId: z.uuid(),
  projectId: z.uuid(),
  jobs: z.array(pipelineJobSchema),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export class MediaPipelineApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MediaPipelineApiError";
  }
}

export function createMediaPipelineApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    sourceUrl(projectId: string): string {
      return `${basePath}/projects/${encodeURIComponent(projectId)}/source`;
    },
    async createCuts(input: {
      projectId: string;
      idempotencyKey: string;
      segments: Array<{
        clientSegmentId: string;
        startMs: number;
        endMs: number;
      }>;
    }): Promise<CreateCutsResponse> {
      return request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(input.projectId)}/cuts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({ segments: input.segments }),
        },
        createCutsResponseSchema,
      );
    },
    async getJob(id: string): Promise<PipelineJob> {
      return request(
        fetchImplementation,
        `${basePath}/pipeline-jobs/${encodeURIComponent(id)}`,
        {},
        pipelineJobSchema,
      );
    },
  };
}

async function request<T>(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImplementation(url, init);
  } catch {
    throw new MediaPipelineApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API.",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new MediaPipelineApiError(
      parsed.success ? parsed.data.error.code : "API_RESPONSE_INVALID",
      parsed.success
        ? parsed.data.error.message
        : "Сервер вернул некорректный ответ.",
      response.status,
    );
  }
  return schema.parse(payload);
}
