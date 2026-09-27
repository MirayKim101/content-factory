import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  TwitchChannelReconciliationTarget,
  TwitchIngestionWorkerRepository,
  TwitchVodPage,
} from "../application/twitch-reconciliation.port.js";

export class PgTwitchIngestionWorkerRepository implements TwitchIngestionWorkerRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  async enabledBroadcasterIds(limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ broadcasterId: string }>(
      `SELECT "broadcasterId" FROM "TwitchIngestChannel"
        WHERE "state" = 'ENABLED' ORDER BY "id" ASC LIMIT $1`,
      [Math.max(1, Math.min(1000, Math.trunc(limit)))],
    );
    return result.rows.map((row) => row.broadcasterId);
  }

  async processInbox(limit = 100): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string;
        channelId: string;
        subscriptionType: string;
        messageTimestamp: Date;
      }>(
        `SELECT "id", "channelId", "subscriptionType", "messageTimestamp"
           FROM "TwitchEventInbox"
          WHERE "state" = 'RECEIVED'
          ORDER BY "receivedAt" ASC, "id" ASC
          FOR UPDATE SKIP LOCKED LIMIT $1`,
        [Math.max(1, Math.min(500, Math.trunc(limit)))],
      );
      for (const row of result.rows) {
        const field =
          row.subscriptionType === "stream.online"
            ? '"lastOnlineAt"'
            : row.subscriptionType === "stream.offline"
              ? '"lastOfflineAt"'
              : null;
        if (!field) {
          await this.reject(client, row.id, "TWITCH_EVENT_TYPE_UNSUPPORTED");
          continue;
        }
        await client.query(
          `UPDATE "TwitchIngestChannel" SET ${field} = GREATEST(COALESCE(${field}, $2), $2), "updatedAt" = now() WHERE "id" = $1`,
          [row.channelId, row.messageTimestamp],
        );
        await client.query(
          `UPDATE "TwitchEventInbox" SET "state" = 'PROCESSED', "processedAt" = now(), "updatedAt" = now() WHERE "id" = $1`,
          [row.id],
        );
      }
      await client.query("COMMIT");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async promoteReady(now: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE "TwitchVodCandidate"
          SET "state" = 'READY_FOR_INGEST', "updatedAt" = $1
        WHERE "state" = 'WAITING_DELAY' AND "availableForIngestAt" <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async dueChannels(limit = 25): Promise<TwitchChannelReconciliationTarget[]> {
    const result = await this.pool.query<{
      id: string;
      broadcasterId: string;
      reconciliationCursor: string | null;
      ingestDelaySeconds: number;
    }>(
      `SELECT "id", "broadcasterId", "reconciliationCursor", "ingestDelaySeconds"
         FROM "TwitchIngestChannel"
        WHERE "state" = 'ENABLED'
          AND ("lastReconciledAt" IS NULL OR "lastReconciledAt" <= now() - interval '5 minutes')
        ORDER BY "lastReconciledAt" ASC NULLS FIRST, "id" ASC LIMIT $1`,
      [Math.max(1, Math.min(100, Math.trunc(limit)))],
    );
    return result.rows.map((row) => ({
      id: row.id,
      broadcasterId: row.broadcasterId,
      cursor: row.reconciliationCursor,
      ingestDelaySeconds: row.ingestDelaySeconds,
    }));
  }

  async applyVodPage(
    channel: TwitchChannelReconciliationTarget,
    page: TwitchVodPage,
    now: Date,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const locked = await client.query<{
        state: string;
        reconciliationCursor: string | null;
      }>(
        `SELECT "state", "reconciliationCursor" FROM "TwitchIngestChannel" WHERE "id" = $1 FOR UPDATE`,
        [channel.id],
      );
      const row = locked.rows[0];
      if (
        !row ||
        row.state !== "ENABLED" ||
        row.reconciliationCursor !== channel.cursor
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const vod of page.items) {
        const availableAt = new Date(
          Math.max(
            now.getTime(),
            vod.publishedAt.getTime() + channel.ingestDelaySeconds * 1000,
          ),
        );
        await client.query(
          `INSERT INTO "TwitchVodCandidate"
            ("id", "channelId", "providerVideoId", "streamId", "title", "vodType",
             "durationSeconds", "startedAt", "publishedAt", "availableForIngestAt",
             "state", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   CASE WHEN $10 <= $11 THEN 'READY_FOR_INGEST'::"TwitchVodCandidateState" ELSE 'WAITING_DELAY'::"TwitchVodCandidateState" END,
                   $11, $11)
           ON CONFLICT ("providerVideoId") DO UPDATE SET
             "title" = EXCLUDED."title", "durationSeconds" = EXCLUDED."durationSeconds",
             "publishedAt" = EXCLUDED."publishedAt", "updatedAt" = EXCLUDED."updatedAt"
           WHERE "TwitchVodCandidate"."channelId" = EXCLUDED."channelId"
             AND "TwitchVodCandidate"."state" IN ('WAITING_DELAY', 'READY_FOR_INGEST')`,
          [
            randomUUID(),
            channel.id,
            vod.providerVideoId,
            vod.streamId,
            vod.title,
            vod.vodType,
            vod.durationSeconds,
            vod.startedAt,
            vod.publishedAt,
            availableAt,
            now,
          ],
        );
      }
      await client.query(
        `UPDATE "TwitchIngestChannel" SET "reconciliationCursor" = $2,
          "lastReconciledAt" = $3, "updatedAt" = $3 WHERE "id" = $1`,
        [channel.id, page.nextCursor, now],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  private reject(client: PoolClient, id: string, code: string) {
    return client.query(
      `UPDATE "TwitchEventInbox" SET "state" = 'REJECTED', "failureCode" = $2,
        "failureMessage" = 'Unsupported durable inbox event.', "processedAt" = now(),
        "updatedAt" = now() WHERE "id" = $1`,
      [id, code],
    );
  }
}
