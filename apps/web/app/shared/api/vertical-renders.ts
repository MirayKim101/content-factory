import { z } from "zod";

import { parseApiBasePath } from "~/shared/config/api-config";

const uuid = z.uuid();
const jobSchema = z.object({
  id: uuid,
  state: z.enum([
    "QUEUED",
    "PROCESSING",
    "RETRY_WAIT",
    "READY",
    "FAILED_FINAL",
  ]),
  attemptCount: z.number().int().nonnegative(),
  retryBudget: z.number().int().nonnegative(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
});
const approvalSchema = z.object({ id: uuid, createdAt: z.iso.datetime() });
const resultSchema = z.object({
  id: uuid,
  artifactId: uuid,
  width: z.number().int(),
  height: z.number().int(),
  sizeBytes: z.string().regex(/^\d+$/),
  downloadUrl: z.string(),
  completedAt: z.iso.datetime(),
  approval: approvalSchema.nullable(),
});
const renderSchema = z.object({
  id: uuid,
  projectId: uuid,
  cutPipelineJobId: uuid,
  framingMode: z.literal("CENTER_CROP"),
  outputWidth: z.literal(1080),
  outputHeight: z.literal(1920),
  renderContractVersion: z.literal("vertical-render-v1"),
  job: jobSchema,
  result: resultSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type VerticalRender = z.infer<typeof renderSchema>;
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() }),
});
const capabilitiesSchema = z.object({ renderEnabled: z.boolean() });

export class VerticalRendersApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VerticalRendersApiError";
  }
}

export function createVerticalRendersApi(
  apiBasePath: unknown,
  fetcher: typeof fetch = fetch,
) {
  const base = parseApiBasePath(apiBasePath);
  return {
    capabilities: () =>
      request(
        fetcher,
        `${base}/vertical-renders/capabilities`,
        {},
        capabilitiesSchema,
      ),
    list: (projectId: string) =>
      request(
        fetcher,
        `${base}/projects/${encodeURIComponent(projectId)}/vertical-renders`,
        {},
        z.array(renderSchema),
      ),
    create: (
      projectId: string,
      cutPipelineJobId: string,
      idempotencyKey: string,
    ) =>
      request(
        fetcher,
        `${base}/projects/${encodeURIComponent(projectId)}/vertical-renders`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ cutPipelineJobId }),
        },
        renderSchema,
      ),
    approve: (id: string) =>
      request(
        fetcher,
        `${base}/vertical-renders/${encodeURIComponent(id)}/approve`,
        { method: "POST" },
        approvalSchema,
      ),
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
    throw new VerticalRendersApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API вертикальных роликов.",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    const code = parsed.success
      ? parsed.data.error.code
      : "API_RESPONSE_INVALID";
    const messages: Record<string, string> = {
      VERTICAL_RENDER_DISABLED:
        "Вертикальный рендер выключен в конфигурации сервера.",
      VERTICAL_RENDER_CONFLICT:
        "Исходная нарезка изменилась или уже недоступна.",
      IDEMPOTENCY_KEY_INVALID: "Некорректный ключ операции.",
    };
    const message =
      messages[code] ??
      (parsed.success
        ? (parsed.data.error.message ?? "Не удалось выполнить действие.")
        : "Сервер вернул некорректный ответ.");
    throw new VerticalRendersApiError(code, message, response.status);
  }
  return schema.parse(payload);
}
