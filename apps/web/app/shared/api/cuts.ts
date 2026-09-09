import { z } from "zod";
import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";
import { ProjectApiError, ProjectNetworkError } from "./projects";

export type CutJob = components["schemas"]["CutJobDto"];
export type CutJobPage = components["schemas"]["CutJobPageDto"];

const cutJobSchema: z.ZodType<CutJob> = z.object({
  id: z.uuid(),
  sourceId: z.uuid(),
  sourceVersion: z.number().int().positive(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  state: z.enum([
    "QUEUED",
    "RUNNING",
    "FAILED_RETRYABLE",
    "SUCCEEDED",
    "FAILED_FINAL",
  ]),
  stage: z.string(),
  progress: z
    .object({
      current: z.string().regex(/^\d+$/),
      total: z.string().regex(/^\d+$/),
      unit: z.enum(["BYTES", "MILLISECONDS"]),
    })
    .nullable(),
  attempts: z.number().int().nonnegative(),
  queueReason: z.string().nullable(),
  admissionDeadlineAt: z.iso.datetime(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  recipeVersion: z.string(),
  revision: z.number().int().nonnegative(),
  artifact: z
    .object({
      id: z.uuid(),
      sizeBytes: z.string().regex(/^\d+$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      contentType: z.string(),
      downloadUrl: z.string(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const pageSchema: z.ZodType<CutJobPage> = z.object({
  items: z.array(cutJobSchema),
  nextCursor: z.string().nullable(),
});

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export interface CutsApi {
  create(
    projectId: string,
    request: { startMs: number; endMs: number; idempotencyKey: string },
  ): Promise<CutJob>;
  list(projectId: string, signal?: AbortSignal): Promise<CutJobPage>;
  get(projectId: string, jobId: string, signal?: AbortSignal): Promise<CutJob>;
  sourceUrl(projectId: string): string;
}

export function createCutsApi(options: {
  apiBasePath: unknown;
  fetchImplementation?: typeof fetch;
}): CutsApi {
  const base = parseApiBasePath(options.apiBasePath);
  const request = options.fetchImplementation ?? fetch;
  async function json<T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await request(url, init);
    } catch {
      throw new ProjectNetworkError();
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      throw new ProjectApiError(
        parsed.success ? parsed.data.error.message : "API request failed.",
        parsed.success ? parsed.data.error.code : "UNKNOWN",
        response.status,
      );
    }
    return schema.parse(payload);
  }
  return {
    create(projectId, input) {
      return json(
        `${base}/projects/${projectId}/cut-jobs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({ startMs: input.startMs, endMs: input.endMs }),
        },
        cutJobSchema,
      );
    },
    list(projectId, signal) {
      return json(
        `${base}/projects/${projectId}/cut-jobs?limit=100`,
        { signal },
        pageSchema,
      );
    },
    get(projectId, jobId, signal) {
      return json(
        `${base}/projects/${projectId}/cut-jobs/${jobId}`,
        { signal },
        cutJobSchema,
      );
    },
    sourceUrl(projectId) {
      return `${base}/projects/${projectId}/source/media`;
    },
  };
}
