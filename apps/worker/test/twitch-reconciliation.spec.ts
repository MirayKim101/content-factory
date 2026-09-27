import { describe, expect, it, vi } from "vitest";

import { ReconcileTwitchIngestion } from "../src/application/reconcile-twitch-ingestion.js";
import type { TwitchIngestionWorkerRepository } from "../src/application/twitch-reconciliation.port.js";
import { PgTwitchIngestionWorkerRepository } from "../src/infrastructure/pg-twitch-ingestion-worker.repository.js";
import {
  parseTwitchDuration,
  parseTwitchVodPage,
  TwitchHelixClient,
} from "../src/infrastructure/twitch-helix-client.js";

describe("Twitch reconciliation", () => {
  it("polls enabled channels even when EventSub offline was missed", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "channel-1",
          broadcasterId: "1337",
          reconciliationCursor: null,
          ingestDelaySeconds: 300,
        },
      ],
    });
    const repository = new PgTwitchIngestionWorkerRepository(
      "postgresql://unused",
    );
    const originalPool = (
      repository as unknown as { pool: { end(): Promise<void> } }
    ).pool;
    (
      repository as unknown as {
        pool: { query: typeof query; end(): Promise<void> };
      }
    ).pool = { query, end: vi.fn() };

    await expect(repository.dueChannels()).resolves.toEqual([
      {
        id: "channel-1",
        broadcasterId: "1337",
        cursor: null,
        ingestDelaySeconds: 300,
      },
    ]);
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).not.toContain('"lastOfflineAt" IS NOT NULL');
    expect(sql).toContain("\"state\" = 'ENABLED'");
    query.mockResolvedValueOnce({ rowCount: 2 });
    const now = new Date("2026-09-28T00:00:00.000Z");
    await expect(repository.promoteReady(now)).resolves.toBe(2);
    expect(String(query.mock.calls[1]![0])).toContain(
      '"availableForIngestAt" <= $1',
    );
    expect(query.mock.calls[1]![1]).toEqual([now]);
    await originalPool.end();
  });

  it("parses bounded archive metadata and Twitch duration", () => {
    expect(parseTwitchDuration("12h34m56s")).toBe(45_296);
    expect(parseTwitchDuration("45m2s")).toBe(2_702);
    expect(parseTwitchDuration("99m")).toBe(0);
    expect(
      parseTwitchVodPage({
        data: [
          {
            id: "vod-1",
            stream_id: "stream-1",
            title: "Archive",
            type: "archive",
            duration: "1h2m3s",
            created_at: "2026-09-27T10:00:00Z",
            published_at: "2026-09-27T11:00:00Z",
          },
        ],
        pagination: { cursor: "next" },
      }),
    ).toEqual({
      items: [
        expect.objectContaining({
          providerVideoId: "vod-1",
          durationSeconds: 3723,
          vodType: "archive",
        }),
      ],
      nextCursor: "next",
    });
  });

  it("uses the official archives filter without leaking credentials into the URL", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [], pagination: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await new TwitchHelixClient(
      "client-id",
      "secret-token",
      fetchMock as typeof fetch,
    ).listArchives("1337", "cursor-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("user_id=1337&type=archive&first=100&after=cursor-1");
    expect(url).not.toContain("secret-token");
    expect(init?.headers).toEqual({
      "Client-Id": "client-id",
      Authorization: "Bearer secret-token",
    });
  });

  it("isolates a failed channel without blocking the remaining channels", async () => {
    const failed = {
      id: "channel-1",
      broadcasterId: "1337",
      cursor: null,
      ingestDelaySeconds: 300,
    };
    const healthy = { ...failed, id: "channel-2", broadcasterId: "7331" };
    const repository: TwitchIngestionWorkerRepository = {
      processInbox: vi.fn(async () => 1),
      promoteReady: vi.fn(async () => 0),
      dueChannels: vi.fn(async () => [failed, healthy]),
      applyVodPage: vi.fn(async () => true),
      close: vi.fn(),
    };
    const provider = {
      listArchives: vi.fn(async (broadcasterId: string) => {
        if (broadcasterId === "1337") throw new Error("TWITCH_HELIX_503");
        return { items: [], nextCursor: null };
      }),
    };
    await expect(
      new ReconcileTwitchIngestion(repository, provider).execute(),
    ).resolves.toEqual({
      events: 1,
      channels: 2,
      failedChannels: ["channel-1"],
    });
    expect(repository.applyVodPage).toHaveBeenCalledOnce();
    expect(repository.applyVodPage).toHaveBeenCalledWith(
      healthy,
      { items: [], nextCursor: null },
      expect.any(Date),
    );
  });

  it("drains bounded Helix pages in one channel pass and advances each durable cursor", async () => {
    const channel = {
      id: "channel-1",
      broadcasterId: "1337",
      cursor: null,
      ingestDelaySeconds: 300,
    };
    const repository: TwitchIngestionWorkerRepository = {
      processInbox: vi.fn(async () => 0),
      promoteReady: vi.fn(async () => 0),
      dueChannels: vi.fn(async () => [channel]),
      applyVodPage: vi.fn(async () => true),
      close: vi.fn(),
    };
    const provider = {
      listArchives: vi
        .fn()
        .mockResolvedValueOnce({ items: [], nextCursor: "page-2" })
        .mockResolvedValueOnce({ items: [], nextCursor: "page-3" })
        .mockResolvedValueOnce({ items: [], nextCursor: null }),
    };

    await expect(
      new ReconcileTwitchIngestion(repository, provider).execute(),
    ).resolves.toEqual({ events: 0, channels: 1, failedChannels: [] });
    expect(provider.listArchives.mock.calls.map((call) => call[1])).toEqual([
      null,
      "page-2",
      "page-3",
    ]);
    expect(repository.applyVodPage).toHaveBeenCalledTimes(3);
    expect(channel.cursor).toBeNull();
  });

  it("stops cursor cycles and reports only that channel as failed", async () => {
    const repository: TwitchIngestionWorkerRepository = {
      processInbox: vi.fn(async () => 0),
      promoteReady: vi.fn(async () => 0),
      dueChannels: vi.fn(async () => [
        {
          id: "channel-cycle",
          broadcasterId: "1337",
          cursor: "same-cursor",
          ingestDelaySeconds: 300,
        },
      ]),
      applyVodPage: vi.fn(async () => true),
      close: vi.fn(),
    };
    const provider = {
      listArchives: vi.fn(async () => ({
        items: [],
        nextCursor: "same-cursor",
      })),
    };

    await expect(
      new ReconcileTwitchIngestion(repository, provider).execute(),
    ).resolves.toEqual({
      events: 0,
      channels: 1,
      failedChannels: ["channel-cycle"],
    });
    expect(provider.listArchives).toHaveBeenCalledOnce();
    expect(repository.applyVodPage).toHaveBeenCalledOnce();
  });

  it("stops pagination when a concurrent reconciliation changed the durable cursor", async () => {
    const repository: TwitchIngestionWorkerRepository = {
      processInbox: vi.fn(async () => 0),
      promoteReady: vi.fn(async () => 0),
      dueChannels: vi.fn(async () => [
        {
          id: "channel-raced",
          broadcasterId: "1337",
          cursor: null,
          ingestDelaySeconds: 300,
        },
      ]),
      applyVodPage: vi.fn(async () => false),
      close: vi.fn(),
    };
    const provider = {
      listArchives: vi.fn(async () => ({
        items: [],
        nextCursor: "must-not-be-requested",
      })),
    };

    await expect(
      new ReconcileTwitchIngestion(repository, provider).execute(),
    ).resolves.toEqual({ events: 0, channels: 1, failedChannels: [] });
    expect(provider.listArchives).toHaveBeenCalledOnce();
    expect(repository.applyVodPage).toHaveBeenCalledOnce();
  });
});
