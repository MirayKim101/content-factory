import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { ProcessTwitchVodIngest } from "../src/application/process-twitch-vod-ingest.js";
import { workerConfig } from "../src/config.js";
import { HttpTwitchVodMediaProvider } from "../src/infrastructure/http-twitch-vod-media-provider.js";
import { PgTwitchIngestionWorkerRepository } from "../src/infrastructure/pg-twitch-ingestion-worker.repository.js";
import { S3WorkerObjectStorage } from "../src/infrastructure/s3-worker-object-storage.js";

describe.skipIf(process.env.RUN_TWITCH_INGEST_INTEGRATION !== "1")(
  "Twitch VOD ingest integration",
  () => {
    it("claims work fairly across channels", async () => {
      const config = workerConfig();
      const pool = new Pool({ connectionString: config.databaseUrl });
      const repository = new PgTwitchIngestionWorkerRepository(
        config.databaseUrl,
      );
      const recentChannelId = randomUUID();
      const waitingChannelId = randomUUID();
      const recentCandidateId = randomUUID();
      const waitingCandidateId = randomUUID();
      const recentIntentId = randomUUID();
      const waitingIntentId = randomUUID();
      const suffix = Date.now().toString();

      try {
        await pool.query(
          `INSERT INTO "TwitchIngestChannel" ("id","broadcasterId","broadcasterLogin","broadcasterDisplayName","state","ingestDelaySeconds","lastIngestClaimedAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,'Recent','ENABLED',60,now(),now(),now()),
                  ($4,$5,$6,'Waiting','ENABLED',60,NULL,now(),now())`,
          [
            recentChannelId,
            `recent-${suffix}`,
            `recent_${suffix}`,
            waitingChannelId,
            `waiting-${suffix}`,
            `waiting_${suffix}`,
          ],
        );
        await pool.query(
          `INSERT INTO "TwitchVodCandidate" ("id","channelId","providerVideoId","title","vodType","durationSeconds","startedAt","publishedAt","availableForIngestAt","state","createdAt","updatedAt")
           VALUES ($1,$2,$3,'Recent VOD','archive',60,now(),now(),now(),'READY_FOR_INGEST',now()-interval '1 hour',now()),
                  ($4,$5,$6,'Waiting VOD','archive',60,now(),now(),now(),'READY_FOR_INGEST',now(),now())`,
          [
            recentCandidateId,
            recentChannelId,
            `recent-vod-${suffix}`,
            waitingCandidateId,
            waitingChannelId,
            `waiting-vod-${suffix}`,
          ],
        );
        await pool.query(
          `INSERT INTO "TwitchVodIngestIntent" ("id","idempotencyKey","requestFingerprint","candidateId","state","projectName","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,'QUEUED','Recent import',now()-interval '1 hour',now()),
                  ($5,$6,$7,$8,'QUEUED','Waiting import',now(),now())`,
          [
            recentIntentId,
            `fairness:${recentIntentId}`,
            recentIntentId.replaceAll("-", ""),
            recentCandidateId,
            waitingIntentId,
            `fairness:${waitingIntentId}`,
            waitingIntentId.replaceAll("-", ""),
            waitingCandidateId,
          ],
        );

        const lease = await repository.claimNext("fairness-worker", 60_000);

        expect(lease?.id).toBe(waitingIntentId);
        const marker = await pool.query<{ lastIngestClaimedAt: Date | null }>(
          `SELECT "lastIngestClaimedAt" FROM "TwitchIngestChannel" WHERE "id"=$1`,
          [waitingChannelId],
        );
        expect(marker.rows[0]?.lastIngestClaimedAt).toBeInstanceOf(Date);
        await pool.query(
          `UPDATE "TwitchIngestChannel" SET "state"='REVOKED', "updatedAt"=now()
            WHERE "id"=$1`,
          [waitingChannelId],
        );
        await expect(
          repository.heartbeat(waitingIntentId, "fairness-worker", 60_000),
        ).resolves.toBe(false);
        const released = await pool.query<{
          state: string;
          attemptCount: number;
          leaseOwner: string | null;
        }>(
          `SELECT "state", "attemptCount", "leaseOwner"
             FROM "TwitchVodIngestIntent" WHERE "id"=$1`,
          [waitingIntentId],
        );
        expect(released.rows[0]).toEqual({
          state: "QUEUED",
          attemptCount: 0,
          leaseOwner: null,
        });
        await expect(
          repository.checkpoint(waitingIntentId, "fairness-worker", 1n, 2n),
        ).rejects.toThrow("TWITCH_VOD_INGEST_LEASE_LOST");
        await pool.query(
          `UPDATE "TwitchVodIngestIntent"
              SET "state"='UPLOADING', "attemptCount"=1,
                  "leaseOwner"='finalize-worker',
                  "leaseExpiresAt"=now()+interval '1 minute'
            WHERE "id"=$1`,
          [waitingIntentId],
        );
        const rejectedProjectId = randomUUID();
        await expect(
          repository.complete({
            intentId: waitingIntentId,
            workerId: "finalize-worker",
            projectId: rejectedProjectId,
            sourceId: randomUUID(),
            artifactId: randomUUID(),
            objectKey: "rejected/object.mp4",
            sizeBytes: 1n,
            sha256: "0".repeat(64),
          }),
        ).rejects.toThrow("TWITCH_VOD_INGEST_LEASE_LOST");
        const finalizeRejected = await pool.query<{
          state: string;
          attemptCount: number;
          leaseOwner: string | null;
          projectExists: boolean;
        }>(
          `SELECT i."state", i."attemptCount", i."leaseOwner",
                  EXISTS(SELECT 1 FROM "Project" p WHERE p."id"=$2) AS "projectExists"
             FROM "TwitchVodIngestIntent" i WHERE i."id"=$1`,
          [waitingIntentId, rejectedProjectId],
        );
        expect(finalizeRejected.rows[0]).toEqual({
          state: "QUEUED",
          attemptCount: 0,
          leaseOwner: null,
          projectExists: false,
        });
      } finally {
        await pool.query(
          `DELETE FROM "TwitchVodIngestIntent" WHERE "id" = ANY($1::uuid[])`,
          [[recentIntentId, waitingIntentId]],
        );
        await pool.query(
          `DELETE FROM "TwitchVodCandidate" WHERE "id" = ANY($1::uuid[])`,
          [[recentCandidateId, waitingCandidateId]],
        );
        await pool.query(
          `DELETE FROM "TwitchIngestChannel" WHERE "id" = ANY($1::uuid[])`,
          [[recentChannelId, waitingChannelId]],
        );
        await Promise.all([repository.close(), pool.end()]);
      }
    });

    it("imports gateway bytes into private storage and an unauthorized project", async () => {
      const config = workerConfig();
      const pool = new Pool({ connectionString: config.databaseUrl });
      const repository = new PgTwitchIngestionWorkerRepository(
        config.databaseUrl,
      );
      const storage = new S3WorkerObjectStorage(
        config.storage.bucket,
        config.storage,
      );
      const scratch = await mkdtemp(join(tmpdir(), "twitch-vod-e2e-"));
      const channelId = randomUUID();
      const candidateId = randomUUID();
      const intentId = randomUUID();
      const providerVideoId = `${Date.now()}`;
      const bytes = Buffer.concat([
        Buffer.from([0, 0, 0, 20]),
        Buffer.from("ftypisom"),
        Buffer.alloc(1024 * 1024, 17),
      ]);
      let objectKey: string | undefined;
      let projectId: string | undefined;
      const server = createServer((request, response) => {
        if (request.headers.authorization !== "Bearer integration-token") {
          response.writeHead(401).end();
          return;
        }
        const offset = Number(
          /^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0,
        );
        const body = bytes.subarray(offset);
        response.writeHead(offset ? 206 : 200, {
          "content-type": "video/mp4",
          "content-length": body.length,
          ...(offset
            ? {
                "content-range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
              }
            : {}),
        });
        response.end(body);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("TEST_SERVER_ADDRESS_MISSING");
      try {
        await pool.query(
          `INSERT INTO "TwitchIngestChannel" ("id","broadcasterId","broadcasterLogin","broadcasterDisplayName","state","ingestDelaySeconds","createdAt","updatedAt")
           VALUES ($1,$2,'integration','Integration','ENABLED',60,now(),now())`,
          [channelId, providerVideoId],
        );
        await pool.query(
          `INSERT INTO "TwitchVodCandidate" ("id","channelId","providerVideoId","title","vodType","durationSeconds","startedAt","publishedAt","availableForIngestAt","state","createdAt","updatedAt")
           VALUES ($1,$2,$3,'Integration VOD','archive',60,now(),now(),now(),'READY_FOR_INGEST',now(),now())`,
          [candidateId, channelId, providerVideoId],
        );
        await pool.query(
          `INSERT INTO "TwitchVodIngestIntent" ("id","idempotencyKey","requestFingerprint","candidateId","state","projectName","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,'QUEUED','Integration import',now(),now())`,
          [
            intentId,
            `integration:${intentId}`,
            intentId.replaceAll("-", ""),
            candidateId,
          ],
        );
        const processor = new ProcessTwitchVodIngest(
          repository,
          new HttpTwitchVodMediaProvider({
            baseUrl: `http://127.0.0.1:${address.port}`,
            bearerToken: "integration-token",
            timeoutMs: 5_000,
          }),
          storage,
          scratch,
          2n * 1024n * 1024n,
          60_000,
        );
        await expect(processor.execute("integration-worker")).resolves.toBe(
          true,
        );
        const result = await pool.query<{
          state: string;
          projectId: string;
          objectKey: string;
          authorization: string;
        }>(
          `SELECT i."state", i."projectId", a."objectKey", z."status" AS authorization
           FROM "TwitchVodIngestIntent" i
           JOIN "Project" p ON p."id"=i."projectId"
           JOIN "VideoSource" s ON s."projectId"=p."id"
           JOIN "MediaArtifact" a ON a."projectId"=p."id" AND a."role"='SOURCE'
           JOIN "SourceAuthorization" z ON z."sourceId"=s."id" AND z."sourceVersion"=s."sourceVersion"
           WHERE i."id"=$1`,
          [intentId],
        );
        expect(result.rows[0]).toMatchObject({
          state: "READY",
          authorization: "NOT_REVIEWED",
        });
        projectId = result.rows[0]!.projectId;
        objectKey = result.rows[0]!.objectKey;
        await storage.verifyIdentity({
          objectKey,
          sizeBytes: BigInt(bytes.length),
          sha256: createSha(bytes),
          contentType: "video/mp4",
        });
      } finally {
        if (objectKey) await storage.delete(objectKey).catch(() => undefined);
        await pool
          .query(`DELETE FROM "TwitchVodIngestIntent" WHERE "id"=$1`, [
            intentId,
          ])
          .catch(() => undefined);
        await pool
          .query(`DELETE FROM "TwitchVodCandidate" WHERE "id"=$1`, [
            candidateId,
          ])
          .catch(() => undefined);
        if (projectId)
          await pool
            .query(`DELETE FROM "Project" WHERE "id"=$1`, [projectId])
            .catch(() => undefined);
        await pool
          .query(`DELETE FROM "TwitchIngestChannel" WHERE "id"=$1`, [channelId])
          .catch(() => undefined);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all([repository.close(), pool.end()]);
        storage.close();
        await rm(scratch, { recursive: true, force: true });
      }
    }, 30_000);
  },
);

function createSha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
