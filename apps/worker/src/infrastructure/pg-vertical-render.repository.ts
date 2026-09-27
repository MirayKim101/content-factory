import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type {
  VerticalRenderedFile,
  VerticalRenderClaim,
  VerticalRenderRepository,
} from "../application/vertical-render.port.js";

export class PgVerticalRenderRepository implements VerticalRenderRepository {
  private readonly pool: Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  async claim(
    jobId: string,
    leaseMs: number,
  ): Promise<VerticalRenderClaim | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<{
        jobId: string;
        intentId: string;
        projectId: string;
        sourceId: string;
        sourceVersion: number;
        attemptCount: number;
        retryBudget: number;
        objectKey: string;
        sizeBytes: string;
        current: boolean;
      }>(
        `SELECT j."id" AS "jobId", i."id" AS "intentId", j."projectId", j."sourceId",
                j."sourceVersion", j."attemptCount", j."retryBudget",
                a."objectKey", a."sizeBytes"::text AS "sizeBytes",
                (j."type" = 'RENDER_VERTICAL' AND j."payloadVersion" = 1
                 AND j."recipeVersion" = 'vertical-render-v1'
                 AND j."verticalRenderIntentId" = i."id"
                 AND s."sourceVersion" = j."sourceVersion" AND s."status" = 'READY'
                 AND sa."status" = 'CLEARED'
                 AND i."projectId" = j."projectId" AND i."sourceId" = j."sourceId"
                 AND i."sourceVersion" = j."sourceVersion"
                 AND i."cutResultArtifactId" = a."id"
                 AND a."status" = 'READY' AND a."role" = 'CUT_RESULT'
                 AND a."projectId" = j."projectId" AND a."lineageSourceId" = j."sourceId"
                 AND a."lineageSourceVersion" = j."sourceVersion"
                 AND a."pipelineJobId" = i."cutPipelineJobId"
                 AND i."outputWidth" = 1080 AND i."outputHeight" = 1920) AS "current"
           FROM "PipelineJob" j
           JOIN "VerticalRenderIntent" i ON i."id" = j."verticalRenderIntentId"
           JOIN "MediaArtifact" a ON a."id" = i."cutResultArtifactId"
           JOIN "VideoSource" s ON s."id" = j."sourceId"
           JOIN "SourceAuthorization" sa ON sa."sourceId" = j."sourceId" AND sa."sourceVersion" = j."sourceVersion"
          WHERE j."id" = $1 AND (j."state" IN ('QUEUED', 'RETRY_WAIT') OR
            (j."state" = 'PROCESSING' AND j."leaseExpiresAt" <= now()))
          FOR UPDATE OF j`,
        [jobId],
      );
      const row = selected.rows[0];
      if (!row || !row.current || row.attemptCount > row.retryBudget) {
        if (row)
          await client.query(
            `UPDATE "PipelineJob" SET "state"='FAILED_FINAL', "failureCode"='VERTICAL_LINEAGE_STALE',
              "failureMessage"='Vertical input lineage is no longer current.', "failureRetryable"=false,
              "finishedAt"=now(), "updatedAt"=now() WHERE "id"=$1`,
            [jobId],
          );
        await client.query("COMMIT");
        return null;
      }
      const leaseToken = randomUUID();
      const attemptNumber = row.attemptCount + 1;
      await client.query(
        `UPDATE "PipelineJob" SET "state"='PROCESSING', "attemptCount"=$2,
          "leaseOwner"='vertical-worker', "leaseToken"=$3,
          "leaseExpiresAt"=now()+($4::int * interval '1 millisecond'),
          "heartbeatAt"=now(), "nextAttemptAt"=NULL,
          "startedAt"=COALESCE("startedAt",now()), "updatedAt"=now()
          WHERE "id"=$1`,
        [jobId, attemptNumber, leaseToken, leaseMs],
      );
      await client.query(
        `INSERT INTO "JobAttempt" ("id","jobId","attemptNumber","state","workerId","leaseToken","startedAt","heartbeatAt","createdAt","updatedAt")
         VALUES ($1,$2,$3,'PROCESSING','vertical-worker',$4,now(),now(),now(),now())
         ON CONFLICT ("jobId","attemptNumber") DO UPDATE SET "state"='PROCESSING',
           "workerId"='vertical-worker', "leaseToken"=$4, "startedAt"=now(), "heartbeatAt"=now(), "updatedAt"=now()`,
        [randomUUID(), jobId, attemptNumber, leaseToken],
      );
      await client.query("COMMIT");
      return {
        jobId: row.jobId,
        intentId: row.intentId,
        projectId: row.projectId,
        sourceId: row.sourceId,
        sourceVersion: row.sourceVersion,
        inputObjectKey: row.objectKey,
        inputSizeBytes: BigInt(row.sizeBytes),
        leaseToken,
        attemptNumber,
        retryBudget: row.retryBudget,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(
    claim: VerticalRenderClaim,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "PipelineJob" SET "leaseExpiresAt"=now()+($3::int * interval '1 millisecond'),
        "heartbeatAt"=now(), "updatedAt"=now() WHERE "id"=$1 AND "state"='PROCESSING' AND "leaseToken"=$2`,
      [claim.jobId, claim.leaseToken, leaseMs],
    );
    return result.rowCount === 1;
  }

  async complete(
    claim: VerticalRenderClaim,
    output: VerticalRenderedFile & {
      objectKey: string;
      sizeBytes: bigint;
      sha256: string;
      etag?: string;
      storageVersion?: string;
    },
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const locked = await client.query(
        `SELECT "id" FROM "PipelineJob" WHERE "id"=$1 AND "state"='PROCESSING' AND "leaseToken"=$2 FOR UPDATE`,
        [claim.jobId, claim.leaseToken],
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO "MediaArtifact"
          ("id","projectId","sourceId","role","status","objectKey","storageEtag","storageVersion",
           "sizeBytes","sha256","contentType","lineageSourceId","lineageSourceVersion","recipeVersion",
           "pipelineJobId","ffmpegVersion","outputFilename","createdAt","updatedAt")
         VALUES ($1,$2,$3,'VERTICAL_RENDER_RESULT','READY',$4,$5,$6,$7,$8,'video/mp4',$3,$9,
                 'vertical-render-v1',$10,$11,'vertical.mp4',now(),now())`,
        [
          artifactId,
          claim.projectId,
          claim.sourceId,
          output.objectKey,
          output.etag ?? null,
          output.storageVersion ?? null,
          output.sizeBytes.toString(),
          output.sha256,
          claim.sourceVersion,
          claim.jobId,
          output.ffmpegVersion,
        ],
      );
      await client.query(
        `INSERT INTO "VerticalRenderResult"
          ("id","intentId","pipelineJobId","artifactId","renderContractVersion","durationMs",
           "width","height","sha256","sizeBytes","completedAt","createdAt")
         VALUES ($1,$2,$3,$4,'vertical-render-v1',$5,1080,1920,$6,$7,now(),now())`,
        [
          randomUUID(),
          claim.intentId,
          claim.jobId,
          artifactId,
          output.durationMs,
          output.sha256,
          output.sizeBytes.toString(),
        ],
      );
      await client.query(
        `UPDATE "PipelineJob" SET "state"='READY', "finishedAt"=now(), "leaseOwner"=NULL,
          "leaseToken"=NULL, "leaseExpiresAt"=NULL, "failureCode"=NULL, "failureMessage"=NULL,
          "updatedAt"=now() WHERE "id"=$1`,
        [claim.jobId],
      );
      await client.query(
        `UPDATE "JobAttempt" SET "state"='READY', "finishedAt"=now(), "outputObjectKey"=$4,
          "updatedAt"=now() WHERE "jobId"=$1 AND "attemptNumber"=$2 AND "leaseToken"=$3`,
        [claim.jobId, claim.attemptNumber, claim.leaseToken, output.objectKey],
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

  async fail(
    claim: VerticalRenderClaim,
    code: string,
    message: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    const retryable = claim.attemptNumber <= claim.retryBudget;
    const state = retryable ? "RETRY_WAIT" : "FAILED_FINAL";
    const attemptState = retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL";
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE "PipelineJob" SET "state"=$3::"PipelineJobState", "failureCode"=$4,
          "failureMessage"=$5, "failureRetryable"=$6, "finishedAt"=CASE WHEN $6 THEN NULL ELSE now() END,
          "nextAttemptAt"=CASE WHEN $6 THEN now() + (LEAST(300, 5 * power(2, $7 - 1)) * interval '1 second') ELSE NULL END,
          "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL, "updatedAt"=now()
         WHERE "id"=$1 AND "state"='PROCESSING' AND "leaseToken"=$2`,
        [
          claim.jobId,
          claim.leaseToken,
          state,
          code,
          message,
          retryable,
          claim.attemptNumber,
        ],
      );
      if (updated.rowCount)
        await client.query(
          `UPDATE "JobAttempt" SET "state"=$4::"JobAttemptState", "failureCode"=$5,
            "finishedAt"=now(), "updatedAt"=now() WHERE "jobId"=$1 AND "attemptNumber"=$2 AND "leaseToken"=$3`,
          [
            claim.jobId,
            claim.attemptNumber,
            claim.leaseToken,
            attemptState,
            code,
          ],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async due(limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT "id" FROM "PipelineJob" WHERE "type"='RENDER_VERTICAL' AND
        (("state" IN ('QUEUED','RETRY_WAIT') AND COALESCE("nextAttemptAt",now()) <= now()) OR
         ("state"='PROCESSING' AND "leaseExpiresAt" <= now()))
        ORDER BY "queuedAt" ASC, "id" ASC LIMIT $1`,
      [Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return result.rows.map((row) => row.id);
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
