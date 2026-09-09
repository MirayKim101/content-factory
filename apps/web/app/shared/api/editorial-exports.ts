import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type EditorialExport =
  components["schemas"]["EditorialExportResponseDto"];

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
    "READ_INPUTS",
    "WRITE_ARCHIVE",
    "OUTPUT_HASH",
    "UPLOAD",
    "FINALIZE",
  ]),
  schemaVersion: z.literal("editorial-export-progress-v1"),
  updatedAt: z.iso.datetime(),
});
const exportSchema: z.ZodType<EditorialExport> = z.object({
  id: uuid,
  approvalId: uuid,
  approvalCurrent: z.boolean(),
  approvalCandidateFingerprint: z.string(),
  projectId: uuid,
  sourceId: uuid,
  sourceVersion: z.number().int().positive(),
  cutPipelineJobId: uuid,
  editorialPackageRevisionId: uuid,
  recipeRevisionId: uuid,
  assemblyRenderResultId: uuid,
  exportContractVersion: z.literal("editorial-export-zip-v1"),
  createdAt: z.iso.datetime(),
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
  result: z
    .object({
      completedAt: z.iso.datetime(),
      downloadUrl: z.string(),
      filename: z.string(),
      manifest: z.object({}),
      sha256: z.string(),
      sizeBytes: z.string().regex(/^\d+$/),
    })
    .nullable(),
});
const listSchema = z.object({
  items: z.array(exportSchema),
  nextCursor: z.string().nullable(),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export class EditorialExportsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EditorialExportsApiError";
  }
}

export function createEditorialExportsApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    create(
      approvalId: string,
      idempotencyKey: string,
    ): Promise<EditorialExport> {
      return request(
        fetchImplementation,
        `${basePath}/editorial-approvals/${encodeURIComponent(approvalId)}/exports`,
        { method: "POST", headers: { "Idempotency-Key": idempotencyKey } },
        exportSchema,
      );
    },
    get(exportId: string): Promise<EditorialExport> {
      return request(
        fetchImplementation,
        `${basePath}/editorial-exports/${encodeURIComponent(exportId)}`,
        {},
        exportSchema,
      );
    },
    async list(projectId: string): Promise<EditorialExport[]> {
      const items: EditorialExport[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const params = new URLSearchParams({ limit: "50" });
        if (cursor) params.set("cursor", cursor);
        const parsed = await request(
          fetchImplementation,
          `${basePath}/projects/${encodeURIComponent(projectId)}/editorial-exports?${params}`,
          {},
          listSchema,
        );
        if (parsed.items.some((item) => item.projectId !== projectId)) {
          throw new EditorialExportsApiError(
            "PROJECT_IDENTITY_MISMATCH",
            "Сервер вернул экспорт другого проекта. Список скрыт до безопасного обновления.",
            0,
          );
        }
        items.push(...parsed.items);
        if (!parsed.nextCursor) return unique(items);
        if (cursors.has(parsed.nextCursor)) {
          throw new EditorialExportsApiError(
            "PAGINATION_CURSOR_LOOP",
            "Список экспортов вернул повторяющийся курсор. Обновите страницу.",
            0,
          );
        }
        cursors.add(parsed.nextCursor);
        cursor = parsed.nextCursor;
      }
      throw new EditorialExportsApiError(
        "PAGINATION_LIMIT_REACHED",
        "Слишком много экспортов для безопасной загрузки списка.",
        0,
      );
    },
  };
}

function unique(items: EditorialExport[]): EditorialExport[] {
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
    throw new EditorialExportsApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API. Повторите запрос с тем же ключом.",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new EditorialExportsApiError(
      parsed.success ? parsed.data.error.code : "API_RESPONSE_INVALID",
      parsed.success
        ? parsed.data.error.message
        : "Сервер вернул некорректный ответ.",
      response.status,
    );
  }
  return schema.parse(payload);
}
