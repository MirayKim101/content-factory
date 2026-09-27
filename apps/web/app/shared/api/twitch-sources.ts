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
  lastOnlineAt: z.iso.datetime().nullable(),
  lastOfflineAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TwitchSourceChannel = z.infer<typeof channelSchema>;
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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TwitchVodCandidate = z.infer<typeof vodCandidateSchema>;
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() }),
});

export function createTwitchSourcesApi(
  apiBasePath: unknown,
  fetcher: typeof fetch = fetch,
) {
  const base = parseApiBasePath(apiBasePath);
  return {
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
