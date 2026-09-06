import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type AssemblyRender = components["schemas"]["AssemblyRenderResponseDto"];

const uuid = z.uuid();
const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
const progressSchema = z.object({
  attemptNumber: z.number().int().positive(),
  basisPoints: z.number().int().min(0).max(10_000),
  phase: z.enum([
    "DOWNLOAD",
    "AUDIO_ANALYSIS",
    "ENCODE",
    "OUTPUT_PROBE",
    "OUTPUT_HASH",
    "UPLOAD",
    "FINALIZE",
  ]),
  schemaVersion: z.literal("assembly-progress-v1"),
  updatedAt: z.iso.datetime(),
});
const resultSchema = z.object({
  audioChannels: z.number().int().positive(),
  audioCodec: z.string(),
  audioSampleRate: z.number().int().positive(),
  completedAt: z.iso.datetime(),
  downloadUrl: z.string(),
  durationMs: z.number().int().positive(),
  ffmpegVersion: z.string(),
  ffprobeVersion: z.string(),
  filename: z.string(),
  fpsDenominator: z.number().int().positive(),
  fpsNumerator: z.number().int().positive(),
  height: z.number().int().positive(),
  integratedLoudnessLufs: z.number().finite().nullable(),
  normalizationProfileResult: z.string(),
  pixelFormat: z.string(),
  sha256: z.string(),
  sizeBytes: z.string().regex(/^\d+$/),
  truePeakDbtp: z.number().finite().nullable(),
  videoCodec: z.string(),
  width: z.number().int().positive(),
});
const renderSchema: z.ZodType<AssemblyRender> = z.object({
  id: uuid,
  projectId: uuid,
  sourceId: uuid,
  sourceVersion: z.number().int().positive(),
  cutPipelineJobId: uuid,
  cutResultArtifactId: uuid,
  assemblyRecipeId: uuid,
  recipeRevisionId: uuid,
  recipeRevision: z.number().int().positive(),
  configurationFingerprint: z.string(),
  expectedDurationMs: z.number().int().positive(),
  renderContractVersion: z.literal("horizontal-render-v1"),
  audioProfileVersion: z.literal("youtube-stereo-v1"),
  encodingProfileVersion: z.literal("youtube-h264-v1"),
  inputs: z.array(
    z.object({
      id: uuid,
      role: z.enum(["CUT", "INTRO", "OUTRO", "ADVERTISEMENT", "BANNER"]),
      sha256: z.string(),
      sizeBytes: z.string().regex(/^\d+$/),
      durationMs: z.number().int().positive().nullable(),
      revision: z.number().int().positive().nullable(),
    }),
  ),
  job: z.object({
    id: uuid,
    state: z.enum([
      "QUEUED",
      "PROCESSING",
      "RETRY_WAIT",
      "READY",
      "FAILED_FINAL",
    ]),
    attempt: z.number().int().nonnegative(),
    retryBudget: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    admissionReason: z.string().nullable(),
    nextAttemptAt: z.iso.datetime().nullable(),
    failure: failureSchema.nullable(),
    progress: progressSchema.nullable(),
  }),
  result: resultSchema.nullable(),
  createdAt: z.iso.datetime(),
});
const listSchema = z.object({
  items: z.array(renderSchema),
  nextCursor: z.string().nullable(),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export class AssemblyRendersApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AssemblyRendersApiError";
  }
}

export function createAssemblyRendersApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    async create(
      cutJobId: string,
      recipeRevision: number,
      idempotencyKey: string,
    ): Promise<AssemblyRender> {
      return request(
        fetchImplementation,
        `${basePath}/pipeline-jobs/${encodeURIComponent(cutJobId)}/assembly-renders`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ recipeRevision }),
        },
        renderSchema,
      );
    },
    async get(renderId: string): Promise<AssemblyRender> {
      return request(
        fetchImplementation,
        `${basePath}/assembly-renders/${encodeURIComponent(renderId)}`,
        {},
        renderSchema,
      );
    },
    async list(projectId: string): Promise<AssemblyRender[]> {
      const items: AssemblyRender[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const params = new URLSearchParams({ limit: "50" });
        if (cursor) params.set("cursor", cursor);
        const parsed = await request(
          fetchImplementation,
          `${basePath}/projects/${encodeURIComponent(projectId)}/assembly-renders?${params}`,
          {},
          listSchema,
        );
        items.push(...parsed.items);
        if (!parsed.nextCursor) return unique(items);
        if (cursors.has(parsed.nextCursor))
          throw new AssemblyRendersApiError(
            "PAGINATION_CURSOR_LOOP",
            "Список сборок вернул повторяющийся курсор. Обновите страницу.",
            0,
          );
        cursors.add(parsed.nextCursor);
        cursor = parsed.nextCursor;
      }
      throw new AssemblyRendersApiError(
        "PAGINATION_LIMIT_REACHED",
        "Слишком много сборок для безопасной загрузки списка.",
        0,
      );
    },
  };
}

function unique(items: AssemblyRender[]): AssemblyRender[] {
  const seen = new Set<string>();
  return items.filter(
    (item) => !seen.has(item.id) && (seen.add(item.id), true),
  );
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
    throw new AssemblyRendersApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API. Повторите попытку с тем же действием.",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new AssemblyRendersApiError(
      parsed.success ? parsed.data.error.code : "API_RESPONSE_INVALID",
      parsed.success
        ? parsed.data.error.message
        : "Сервер вернул некорректный ответ.",
      response.status,
    );
  }
  return schema.parse(payload);
}
