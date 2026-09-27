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
