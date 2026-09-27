import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type PublicationChannel =
  components["schemas"]["PublicationChannelResponseDto"];
export type PublicationIntent = Omit<
  components["schemas"]["PublicationIntentResponseDto"],
  "metadataSnapshot" | "failure"
> & {
  metadataSnapshot: Record<string, unknown>;
  failure: { code?: string; message?: string } | null;
};

const uuid = z.uuid();
const platform = z.enum(["LOCAL_DRY_RUN", "YOUTUBE", "TIKTOK"]);
const channelSchema: z.ZodType<PublicationChannel> = z.object({
  id: uuid,
  projectId: uuid,
  platform,
  displayName: z.string(),
  externalChannelRef: z.string(),
  timezone: z.string(),
  state: z.enum(["ENABLED", "REVOKED"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const intentSchema: z.ZodType<PublicationIntent> = z.object({
  id: uuid,
  projectId: uuid,
  channelId: uuid,
  approvalId: uuid,
  exportIntentId: uuid,
  exportResultId: uuid,
  platform,
  scheduledAt: z.iso.datetime(),
  timezone: z.string(),
  metadataSnapshot: z.record(z.string(), z.unknown()),
  state: z.enum([
    "SCHEDULED",
    "QUEUED",
    "PROCESSING",
    "UNKNOWN_REMOTE_STATE",
    "DRY_RUN_READY",
    "PUBLISHED",
    "FAILED_FINAL",
    "CANCELED",
  ]),
  attemptCount: z.number().int().nonnegative(),
  retryBudget: z.number().int().nonnegative(),
  remotePublicationId: z.string().nullable(),
  remoteStatus: z.string().nullable(),
  failure: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const listSchema = z.object({
  items: z.array(intentSchema),
  nextCursor: uuid.nullable(),
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() }),
});

export class PublicationsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PublicationsApiError";
  }
}

export function createPublicationsApi(
  apiBasePath: unknown,
  fetchImplementation: typeof fetch = fetch,
) {
  const basePath = parseApiBasePath(apiBasePath);
  return {
    listChannels: (projectId: string) =>
      request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/publication-channels`,
        {},
        z.array(channelSchema),
      ),
    createDryRunChannel: (
      projectId: string,
      input: { displayName: string; timezone: string },
    ) =>
      request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/publication-channels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: "LOCAL_DRY_RUN",
            externalChannelRef: `local:${projectId}`,
            ...input,
          }),
        },
        channelSchema,
      ),
    list: (projectId: string) =>
      request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/publications?limit=100`,
        {},
        listSchema,
      ),
    create: (
      projectId: string,
      input: {
        channelId: string;
        approvalId: string;
        exportResultId: string;
        scheduledAt: string;
        timezone: string;
        metadataSnapshot: Record<string, unknown>;
      },
      idempotencyKey: string,
    ) =>
      request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/publications`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ platform: "LOCAL_DRY_RUN", ...input }),
        },
        intentSchema,
      ),
    cancel: (id: string) =>
      request(
        fetchImplementation,
        `${basePath}/publications/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
        intentSchema,
      ),
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
    throw new PublicationsApiError(
      "NETWORK_ERROR",
      "Не удалось связаться с API публикаций.",
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
      PUBLISHING_DISABLED: "Публикации выключены в конфигурации сервера.",
      PUBLICATION_CONFLICT:
        "Данные изменились. Обновите очередь и повторите действие.",
      PUBLICATION_REQUEST_INVALID: "Проверьте дату, часовой пояс и метаданные.",
    };
    const message =
      messages[code] ??
      (parsed.success
        ? (parsed.data.error.message ?? "Не удалось выполнить действие.")
        : "Сервер вернул некорректный ответ.");
    throw new PublicationsApiError(code, message, response.status);
  }
  return schema.parse(payload);
}
