import { z } from "zod";

import { parseApiBasePath } from "~/shared/config/api-config";

const channelSchema = z.object({
  id: z.uuid(),
  broadcasterId: z.string(),
  broadcasterLogin: z.string(),
  broadcasterDisplayName: z.string(),
  state: z.enum(["ENABLED", "REVOKED"]),
  ingestDelaySeconds: z.number().int(),
  reconciliationCursor: z.string().nullable(),
  lastReconciledAt: z.iso.datetime().nullable(),
  lastIngestClaimedAt: z.iso.datetime().nullable().optional().default(null),
  lastOnlineAt: z.iso.datetime().nullable(),
  lastOfflineAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TwitchSourceChannel = z.infer<typeof channelSchema>;
const vodIngestIntentSchema = z.object({
  id: z.uuid(),
  candidateId: z.uuid(),
  projectName: z.string(),
  state: z.enum([
    "QUEUED",
    "DOWNLOADING",
    "UPLOADING",
    "RETRY_WAIT",
    "READY",
    "FAILED_FINAL",
    "CANCELED",
  ]),
  projectId: z.uuid().nullable(),
  downloadedBytes: z.string().regex(/^\d+$/),
  totalBytes: z.string().regex(/^\d+$/).nullable(),
  attemptCount: z.number().int().nonnegative(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TwitchVodIngestIntent = z.infer<typeof vodIngestIntentSchema>;
const vodCandidateSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  channel: z.object({
    broadcasterLogin: z.string(),
    broadcasterDisplayName: z.string(),
  }),
  providerVideoId: z.string(),
  streamId: z.string().nullable(),
  title: z.string(),
  vodType: z.enum(["archive", "highlight", "upload"]),
  durationSeconds: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime(),
  availableForIngestAt: z.iso.datetime(),
  state: z.enum(["WAITING_DELAY", "READY_FOR_INGEST", "IMPORTED", "IGNORED"]),
  importedProjectId: z.uuid().nullable(),
  ingestIntent: vodIngestIntentSchema
    .nullish()
    .transform((value) => value ?? null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TwitchVodCandidate = z.infer<typeof vodCandidateSchema>;
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() }),
});
const capabilitiesSchema = z.object({
  ingestionEnabled: z.boolean(),
  autoIngestEnabled: z.boolean(),
});

export function createTwitchSourcesApi(
  apiBasePath: unknown,
  fetcher: typeof fetch = fetch,
) {
  const base = parseApiBasePath(apiBasePath);
  return {
    capabilities: () =>
      request(fetcher, `${base}/twitch/capabilities`, {}, capabilitiesSchema),
    list: () =>
      request(fetcher, `${base}/twitch/channels`, {}, z.array(channelSchema)),
    listVodCandidates: () =>
      request(
        fetcher,
        `${base}/twitch/vod-candidates`,
        {},
        z.array(vodCandidateSchema),
      ),
    save: (input: {
      broadcasterId: string;
      broadcasterLogin: string;
      broadcasterDisplayName: string;
      ingestDelaySeconds: number;
    }) =>
      request(
        fetcher,
        `${base}/twitch/channels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
        channelSchema,
      ),
    revoke: (id: string) =>
      request(
        fetcher,
        `${base}/twitch/channels/${encodeURIComponent(id)}/revoke`,
        { method: "POST" },
        channelSchema,
      ),
    ignoreVodCandidate: (id: string) =>
      request(
        fetcher,
        `${base}/twitch/vod-candidates/${encodeURIComponent(id)}/ignore`,
        { method: "POST" },
        vodCandidateSchema,
      ),
    startVodImport: (id: string, projectName: string, idempotencyKey: string) =>
      request(
        fetcher,
        `${base}/twitch/vod-candidates/${encodeURIComponent(id)}/import`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ projectName }),
        },
        vodIngestIntentSchema,
      ),
    linkVodProject: (
      id: string,
      projectId: string,
      sourceMatchConfirmed: boolean,
    ) =>
      request(
        fetcher,
        `${base}/twitch/vod-candidates/${encodeURIComponent(id)}/link-project`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, sourceMatchConfirmed }),
        },
        vodCandidateSchema,
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
    throw new Error("Не удалось связаться с API источников.");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new Error(
      parsed.success
        ? (parsed.data.error.message ?? parsed.data.error.code)
        : "Сервер вернул некорректный ответ.",
    );
  }
  return schema.parse(payload);
}
