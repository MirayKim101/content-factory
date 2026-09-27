import { z } from "zod";

import type { components } from "~/shared/api/generated/openapi";
import { parseApiBasePath } from "~/shared/config/api-config";

export type PublicationChannel =
  components["schemas"]["PublicationChannelResponseDto"];
export type PublicationIntent = Omit<
  components["schemas"]["PublicationIntentResponseDto"],
  "metadataSnapshot" | "failure" | "latestMetrics"
> & {
  metadataSnapshot: Record<string, unknown>;
  failure: { code?: string; message?: string } | null;
  latestMetrics: {
    viewCount: string;
    likeCount: string | null;
    commentCount: string | null;
    shareCount: string | null;
    observedAt: string;
  } | null;
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
  contentKind: z
    .enum(["EDITORIAL_EXPORT", "VERTICAL_RESULT"])
    .default("EDITORIAL_EXPORT"),
  approvalId: uuid.nullable(),
  exportIntentId: uuid.nullable(),
  exportResultId: uuid.nullable(),
  verticalApprovalId: uuid.nullable().default(null),
  verticalResultId: uuid.nullable().default(null),
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
  latestMetrics: z
    .object({
      viewCount: z.string().regex(/^\d+$/),
      likeCount: z.string().regex(/^\d+$/).nullable(),
      commentCount: z.string().regex(/^\d+$/).nullable(),
      shareCount: z.string().regex(/^\d+$/).nullable(),
      observedAt: z.iso.datetime(),
    })
    .nullable()
    .default(null),
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
const tiktokCreatorInfoSchema = z.object({
  creatorAvatarUrl: z.string(),
  creatorNickname: z.string(),
  creatorUsername: z.string(),
  privacyLevelOptions: z.array(z.string()).min(1),
  commentDisabled: z.boolean(),
  duetDisabled: z.boolean(),
  stitchDisabled: z.boolean(),
  maxVideoPostDurationSec: z.number().int().positive(),
  fetchedAt: z.iso.datetime(),
});
export type TikTokCreatorInfo = z.infer<typeof tiktokCreatorInfoSchema>;

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
    createChannel: (
      projectId: string,
      input: {
        platform: "LOCAL_DRY_RUN" | "YOUTUBE" | "TIKTOK";
        displayName: string;
        externalChannelRef: string;
        timezone: string;
      },
    ) =>
      request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/publication-channels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        channelSchema,
      ),
    getTikTokCreatorInfo: (projectId: string, channelId: string) =>
      request(
        fetchImplementation,
        `${basePath}/projects/${encodeURIComponent(projectId)}/publication-channels/${encodeURIComponent(channelId)}/tiktok-creator-info`,
        {},
        tiktokCreatorInfoSchema,
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
        platform: "LOCAL_DRY_RUN" | "YOUTUBE" | "TIKTOK";
        channelId: string;
        scheduledAt: string;
        timezone: string;
        metadataSnapshot: Record<string, unknown>;
      } & (
        | {
            contentKind: "EDITORIAL_EXPORT";
            approvalId: string;
            exportResultId: string;
          }
        | {
            contentKind: "VERTICAL_RESULT";
            verticalApprovalId: string;
            verticalResultId: string;
          }
      ),
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
          body: JSON.stringify(input),
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
      TIKTOK_CREATOR_INFO_UNAVAILABLE:
        "TikTok временно не вернул настройки автора. Обновите их перед публикацией.",
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
