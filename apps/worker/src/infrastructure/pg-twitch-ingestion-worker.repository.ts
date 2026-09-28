import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { workerPgPoolConfig } from "./worker-pg-pool.js";

import type {
  TwitchChannelReconciliationTarget,
  TwitchIngestionWorkerRepository,
  TwitchVodPage,
} from "../application/twitch-reconciliation.port.js";
import type {
  TwitchVodIngestLease,
  TwitchVodIngestRepository,
} from "../application/twitch-vod-ingest.port.js";

export class PgTwitchIngestionWorkerRepository
  implements TwitchIngestionWorkerRepository, TwitchVodIngestRepository
{
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool(workerPgPoolConfig(databaseUrl, 2));
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
      `UPDATE "TwitchVodCandidate" v
          SET "state" = 'READY_FOR_INGEST', "updatedAt" = $1
         FROM "TwitchIngestChannel" ch
        WHERE v."channelId" = ch."id" AND ch."state" = 'ENABLED'
          AND v."state" = 'WAITING_DELAY' AND v."availableForIngestAt" <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async claimNext(
    workerId: string,
    leaseMs: number,
  ): Promise<TwitchVodIngestLease | null> {
    const result = await this.pool.query<TwitchVodIngestLease>(
      `WITH candidate AS (
         SELECT i."id", v."providerVideoId", ch."id" AS "channelId"
         FROM "TwitchVodIngestIntent" i
         JOIN "TwitchVodCandidate" v ON v."id" = i."candidateId"
         JOIN "TwitchIngestChannel" ch ON ch."id" = v."channelId"
         WHERE v."state" = 'READY_FOR_INGEST'
           AND ch."state" = 'ENABLED'
           AND (i."state" = 'QUEUED' OR (i."state" = 'RETRY_WAIT' AND i."nextAttemptAt" <= now())
             OR (i."state" IN ('DOWNLOADING','UPLOADING') AND i."leaseExpiresAt" <= now()))
         ORDER BY ch."lastIngestClaimedAt" ASC NULLS FIRST, i."createdAt", i."id"
         FOR UPDATE OF i, ch SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE "TwitchVodIngestIntent" i SET "state" = 'DOWNLOADING',
           "attemptCount" = i."attemptCount" + 1, "leaseOwner" = $1,
           "leaseExpiresAt" = now() + ($2 * interval '1 millisecond'),
           "nextAttemptAt" = NULL, "failureCode" = NULL, "failureMessage" = NULL, "updatedAt" = now()
         FROM candidate c WHERE i."id" = c."id"
         RETURNING i."id", i."candidateId", c."providerVideoId", c."channelId",
           i."projectName", i."attemptCount", i."leaseOwner", i."downloadedBytes", i."totalBytes"
       ), touched AS (
         UPDATE "TwitchIngestChannel" ch
         SET "lastIngestClaimedAt" = now(), "updatedAt" = now()
         FROM claimed c WHERE ch."id" = c."channelId"
         RETURNING ch."id"
       )
       SELECT c."id", c."candidateId", c."providerVideoId", c."projectName",
         c."attemptCount", c."leaseOwner", c."downloadedBytes", c."totalBytes"
       FROM claimed c JOIN touched t ON t."id" = c."channelId"`,
      [workerId, Math.max(5_000, leaseMs)],
    );
    const row = result.rows[0];
    return row
      ? {
          ...row,
          downloadedBytes: BigInt(row.downloadedBytes),
          totalBytes: row.totalBytes === null ? null : BigInt(row.totalBytes),
        }
      : null;
  }

  async checkpoint(
    id: string,
    workerId: string,
    downloaded: bigint,
    total: bigint,
  ): Promise<void> {
    await this.fencedUpdate(
      id,
      workerId,
      `"downloadedBytes" = $3, "totalBytes" = $4, "leaseExpiresAt" = now() + interval '2 hours'`,
      [downloaded.toString(), total.toString()],
    );
  }

  async heartbeat(
    id: string,
    workerId: string,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.pool.query<{ channelEnabled: boolean }>(
      `UPDATE "TwitchVodIngestIntent" i
          SET "state" = CASE WHEN ch."state" = 'ENABLED' THEN i."state" ELSE 'QUEUED' END,
              "attemptCount" = CASE WHEN ch."state" = 'ENABLED' THEN i."attemptCount"
                                    ELSE GREATEST(i."attemptCount" - 1, 0) END,
              "leaseOwner" = CASE WHEN ch."state" = 'ENABLED' THEN i."leaseOwner" ELSE NULL END,
              "leaseExpiresAt" = CASE WHEN ch."state" = 'ENABLED'
                                      THEN now() + ($3 * interval '1 millisecond') ELSE NULL END,
              "nextAttemptAt" = CASE WHEN ch."state" = 'ENABLED' THEN i."nextAttemptAt" ELSE NULL END,
              "updatedAt" = now()
         FROM "TwitchVodCandidate" v
         JOIN "TwitchIngestChannel" ch ON ch."id" = v."channelId"
        WHERE i."candidateId" = v."id" AND i."id" = $1 AND i."leaseOwner" = $2
          AND i."state" IN ('DOWNLOADING','UPLOADING')
          AND i."leaseExpiresAt" > now()
        RETURNING (ch."state" = 'ENABLED') AS "channelEnabled"`,
      [id, workerId, Math.max(5_000, leaseMs)],
    );
    return result.rows[0]?.channelEnabled === true;
  }

  async release(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "TwitchVodIngestIntent"
          SET "state" = 'QUEUED',
              "attemptCount" = GREATEST("attemptCount" - 1, 0),
              "nextAttemptAt" = NULL, "leaseOwner" = NULL,
              "leaseExpiresAt" = NULL, "updatedAt" = now()
        WHERE "id" = $1 AND "leaseOwner" = $2
          AND "state" IN ('DOWNLOADING','UPLOADING')
          AND "leaseExpiresAt" > now()`,
      [id, workerId],
    );
    return result.rowCount === 1;
  }

  async beginUpload(
    id: string,
    workerId: string,
    objectKey: string,
    sha256: string,
  ): Promise<void> {
    await this.fencedUpdate(
      id,
      workerId,
      `"state" = 'UPLOADING', "objectKey" = $3, "sha256" = $4, "leaseExpiresAt" = now() + interval '2 hours'`,
      [objectKey, sha256],
    );
  }

  async complete(input: {
    intentId: string;
    workerId: string;
    projectId: string;
    sourceId: string;
    artifactId: string;
    objectKey: string;
    sizeBytes: bigint;
    sha256: string;
    etag?: string;
    version?: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        candidateId: string;
        projectName: string;
        channelEnabled: boolean;
      }>(
        `SELECT i."candidateId", i."projectName",
                (ch."state" = 'ENABLED') AS "channelEnabled"
           FROM "TwitchVodIngestIntent" i
           JOIN "TwitchVodCandidate" v ON v."id" = i."candidateId"
           JOIN "TwitchIngestChannel" ch ON ch."id" = v."channelId"
          WHERE i."id" = $1 AND i."leaseOwner" = $2 AND i."state" = 'UPLOADING'
            AND i."leaseExpiresAt" > now()
          FOR UPDATE OF i, ch`,
        [input.intentId, input.workerId],
      );
      const intent = locked.rows[0];
      if (!intent) throw new Error("TWITCH_VOD_INGEST_LEASE_LOST");
      if (!intent.channelEnabled) {
        await client.query(
          `UPDATE "TwitchVodIngestIntent"
              SET "state"='QUEUED', "attemptCount"=GREATEST("attemptCount"-1,0),
                  "nextAttemptAt"=NULL, "leaseOwner"=NULL, "leaseExpiresAt"=NULL,
                  "updatedAt"=now()
            WHERE "id"=$1 AND "leaseOwner"=$2`,
          [input.intentId, input.workerId],
        );
        await client.query("COMMIT");
        committed = true;
        throw new Error("TWITCH_VOD_INGEST_LEASE_LOST");
      }
      await client.query(
        `INSERT INTO "Project" ("id","idempotencyKey","requestFingerprint","name","status","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,'SOURCE_READY',now(),now())`,
        [
          input.projectId,
          `twitch-vod-ingest:${input.intentId}`,
          input.sha256,
          intent.projectName,
        ],
      );
      await client.query(
        `INSERT INTO "VideoSource" ("id","projectId","status","sourceVersion","originalFilename","contentType","sizeBytes","sha256","createdAt","updatedAt")
         VALUES ($1,$2,'READY',1,$3,'video/mp4',$4,$5,now(),now())`,
        [
          input.sourceId,
          input.projectId,
          `twitch-${intent.candidateId}.mp4`,
          input.sizeBytes.toString(),
          input.sha256,
        ],
      );
      await client.query(
        `INSERT INTO "SourceAuthorization" ("sourceId","sourceVersion","status","revision","createdAt","updatedAt")
         VALUES ($1,1,'NOT_REVIEWED',1,now(),now())`,
        [input.sourceId],
      );
      await client.query(
        `INSERT INTO "MediaArtifact" ("id","projectId","sourceId","role","status","objectKey","storageEtag","storageVersion","sizeBytes","sha256","contentType","lineageSourceId","lineageSourceVersion","recipeVersion","createdAt","updatedAt")
         VALUES ($1,$2,$3,'SOURCE','READY',$4,$5,$6,$7,$8,'video/mp4',$3,1,'twitch-vod-ingest-v1',now(),now())`,
        [
          input.artifactId,
          input.projectId,
          input.sourceId,
          input.objectKey,
          input.etag ?? null,
          input.version ?? null,
          input.sizeBytes.toString(),
          input.sha256,
        ],
      );
      const vod = await client.query(
        `UPDATE "TwitchVodCandidate" SET "state"='IMPORTED', "importedProjectId"=$2, "updatedAt"=now()
         WHERE "id"=$1 AND "state"='READY_FOR_INGEST' AND "importedProjectId" IS NULL`,
        [intent.candidateId, input.projectId],
      );
      if (vod.rowCount !== 1) throw new Error("TWITCH_VOD_INGEST_CONFLICT");
      await client.query(
        `UPDATE "TwitchVodIngestIntent" SET "state"='READY', "projectId"=$3,
         "leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=now()
         WHERE "id"=$1 AND "leaseOwner"=$2`,
        [input.intentId, input.workerId, input.projectId],
      );
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed)
        await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completionMatches(input: {
    intentId: string;
    projectId: string;
    objectKey: string;
    sizeBytes: bigint;
    sha256: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM "TwitchVodIngestIntent" i
         JOIN "TwitchVodCandidate" v ON v."id" = i."candidateId"
         JOIN "Project" p ON p."id" = i."projectId"
         JOIN "VideoSource" s ON s."projectId" = p."id"
         JOIN "SourceAuthorization" z ON z."sourceId" = s."id"
           AND z."sourceVersion" = s."sourceVersion"
         JOIN "MediaArtifact" a ON a."projectId" = p."id"
           AND a."sourceId" = s."id" AND a."role" = 'SOURCE'
        WHERE i."id" = $1 AND i."state" = 'READY' AND i."projectId" = $2
          AND p."status" = 'SOURCE_READY' AND s."status" = 'READY'
          AND v."state" = 'IMPORTED' AND v."importedProjectId" = p."id"
          AND s."sourceVersion" = 1 AND s."contentType" = 'video/mp4'
          AND s."sizeBytes" = $3 AND s."sha256" = $4
          AND z."status" = 'NOT_REVIEWED' AND z."revision" = 1
          AND a."status" = 'READY' AND a."objectKey" = $5
          AND a."contentType" = 'video/mp4' AND a."sizeBytes" = $3
          AND a."sha256" = $4 AND a."lineageSourceId" = s."id"
          AND a."lineageSourceVersion" = 1
          AND a."recipeVersion" = 'twitch-vod-ingest-v1'
        LIMIT 1`,
      [
        input.intentId,
        input.projectId,
        input.sizeBytes.toString(),
        input.sha256,
        input.objectKey,
      ],
    );
    return result.rowCount === 1;
  }

  async fail(
    id: string,
    workerId: string,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    const state = retryable ? "RETRY_WAIT" : "FAILED_FINAL";
    const result = await this.pool.query(
      `UPDATE "TwitchVodIngestIntent" SET "state"=$3::"TwitchVodIngestState",
       "nextAttemptAt"=CASE WHEN $4 THEN now()+interval '1 minute' ELSE NULL END,
       "failureCode"=$5,"failureMessage"=$6,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=now()
       WHERE "id"=$1 AND "leaseOwner"=$2 AND "leaseExpiresAt">now()`,
      [id, workerId, state, retryable, code, message],
    );
    if (result.rowCount !== 1) throw new Error("TWITCH_VOD_INGEST_LEASE_LOST");
  }

  private async fencedUpdate(
    id: string,
    workerId: string,
    assignments: string,
    values: unknown[],
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE "TwitchVodIngestIntent" SET ${assignments}, "updatedAt"=now()
       WHERE "id"=$1 AND "leaseOwner"=$2 AND "state" IN ('DOWNLOADING','UPLOADING')
         AND "leaseExpiresAt">now()`,
      [id, workerId, ...values],
    );
    if (result.rowCount !== 1) throw new Error("TWITCH_VOD_INGEST_LEASE_LOST");
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
