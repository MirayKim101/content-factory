import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { workerPgPoolConfig } from "./worker-pg-pool.js";

import type {
  VerticalRenderedFile,
  VerticalRenderClaim,
  VerticalRenderRepository,
} from "../application/vertical-render.port.js";

export class PgVerticalRenderRepository implements VerticalRenderRepository {
  private readonly pool: Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool(workerPgPoolConfig(databaseUrl, 2));
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
        expectedDurationMs: number;
        current: boolean;
        cleanupPending: boolean;
      }>(
        `SELECT j."id" AS "jobId", i."id" AS "intentId", j."projectId", j."sourceId",
                j."sourceVersion", j."attemptCount", j."retryBudget",
                a."objectKey", a."sizeBytes"::text AS "sizeBytes",
                (segment."endMs" - segment."startMs") AS "expectedDurationMs",
                (j."type" = 'RENDER_VERTICAL' AND j."payloadVersion" = 1
                 AND j."recipeVersion" = 'vertical-render-v1'
                 AND j."verticalRenderIntentId" = i."id"
                 AND i."renderContractVersion" = 'vertical-render-v1'
                 AND i."framingMode" = 'CENTER_CROP'
                 AND s."sourceVersion" = j."sourceVersion" AND s."status" = 'READY'
                 AND sa."status" = 'CLEARED'
                 AND i."projectId" = j."projectId" AND i."sourceId" = j."sourceId"
                 AND i."sourceVersion" = j."sourceVersion"
                 AND i."cutResultArtifactId" = a."id"
                 AND cut."type" = 'CUT_SEGMENT' AND cut."state" = 'READY'
                 AND a."status" = 'READY' AND a."role" = 'CUT_RESULT'
                 AND a."contentType" = 'video/mp4'
                 AND a."projectId" = j."projectId" AND a."lineageSourceId" = j."sourceId"
                 AND a."lineageSourceVersion" = j."sourceVersion"
                 AND a."pipelineJobId" = i."cutPipelineJobId"
                 AND i."outputWidth" = 1080 AND i."outputHeight" = 1920) AS "current",
                EXISTS (
                  SELECT 1 FROM "JobAttempt" pending
                   WHERE pending."jobId"=j."id"
                     AND pending."attemptNumber"=j."attemptCount"+1
                     AND pending."cleanupStatus"='PENDING'
                ) AS "cleanupPending"
           FROM "PipelineJob" j
           JOIN "VerticalRenderIntent" i ON i."id" = j."verticalRenderIntentId"
           JOIN "MediaArtifact" a ON a."id" = i."cutResultArtifactId"
           JOIN "PipelineJob" cut ON cut."id" = i."cutPipelineJobId"
           JOIN "CutSegment" segment ON segment."jobId" = cut."id"
           JOIN "VideoSource" s ON s."id" = j."sourceId"
           JOIN "SourceAuthorization" sa ON sa."sourceId" = j."sourceId" AND sa."sourceVersion" = j."sourceVersion"
          WHERE j."id" = $1 AND (j."state" IN ('QUEUED', 'RETRY_WAIT') OR
            (j."state" = 'PROCESSING' AND j."leaseExpiresAt" <= now()))
          FOR UPDATE OF j`,
        [jobId],
      );
      const row = selected.rows[0];
      if (
        !row ||
        row.cleanupPending ||
        !row.current ||
        row.attemptCount > row.retryBudget
      ) {
        if (row && !row.cleanupPending) {
          const exhausted = row.attemptCount > row.retryBudget;
          await client.query(
            `UPDATE "PipelineJob" SET "state"='FAILED_FINAL', "failureCode"=$2,
              "failureMessage"=$3, "failureRetryable"=false,
              "finishedAt"=now(), "updatedAt"=now() WHERE "id"=$1`,
            [
              jobId,
              exhausted
                ? "VERTICAL_RETRY_BUDGET_EXHAUSTED"
                : "VERTICAL_LINEAGE_STALE",
              exhausted
                ? "Vertical render retry budget is exhausted."
                : "Vertical input lineage is no longer current.",
            ],
          );
        }
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
           "workerId"='vertical-worker', "leaseToken"=$4, "startedAt"=now(),
           "heartbeatAt"=now(), "finishedAt"=NULL, "failureCode"=NULL,
           "outputObjectKey"=NULL, "cleanupStatus"='NOT_REQUIRED',
           "cleanupAttemptCount"=0, "cleanupLastErrorCode"=NULL,
           "cleanupRequestedAt"=NULL, "cleanupCompletedAt"=NULL, "updatedAt"=now()`,
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
        expectedDurationMs: row.expectedDurationMs,
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
        "heartbeatAt"=now(), "updatedAt"=now() WHERE "id"=$1 AND "state"='PROCESSING'
        AND "leaseToken"=$2 AND "leaseExpiresAt">now()`,
      [claim.jobId, claim.leaseToken, leaseMs],
    );
    return result.rowCount === 1;
  }

  async release(claim: VerticalRenderClaim): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ preserveOutput: boolean }>(
        `SELECT (a."outputObjectKey" IS NOT NULL AND a."cleanupStatus"='PENDING') AS "preserveOutput"
           FROM "PipelineJob" j
           JOIN "JobAttempt" a ON a."jobId"=j."id"
            AND a."attemptNumber"=$3 AND a."leaseToken"=$2
          WHERE j."id"=$1 AND j."state"='PROCESSING' AND j."leaseToken"=$2
            AND j."leaseExpiresAt">now()
          FOR UPDATE OF j,a`,
        [claim.jobId, claim.leaseToken, claim.attemptNumber],
      );
      const row = locked.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return false;
      }
      const updated = await client.query(
        `UPDATE "PipelineJob" SET "state"='QUEUED',
          "attemptCount"=GREATEST("attemptCount"-1,0),
          "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
          "heartbeatAt"=NULL, "nextAttemptAt"=NULL, "updatedAt"=now()
         WHERE "id"=$1 AND "state"='PROCESSING' AND "leaseToken"=$2
           AND "leaseExpiresAt">now()`,
        [claim.jobId, claim.leaseToken],
      );
      if (updated.rowCount && row.preserveOutput)
        await client.query(
          `UPDATE "JobAttempt" SET "state"='FAILED_RETRYABLE',
            "failureCode"='VERTICAL_SHUTDOWN_AFTER_OUTPUT_PREPARED',
            "finishedAt"=now(), "updatedAt"=now()
           WHERE "jobId"=$1 AND "attemptNumber"=$2 AND "leaseToken"=$3
             AND "outputObjectKey" IS NOT NULL AND "cleanupStatus"='PENDING'`,
          [claim.jobId, claim.attemptNumber, claim.leaseToken],
        );
      else if (updated.rowCount)
        await client.query(
          `DELETE FROM "JobAttempt" WHERE "jobId"=$1 AND "attemptNumber"=$2
            AND "leaseToken"=$3 AND "state"='PROCESSING'`,
          [claim.jobId, claim.attemptNumber, claim.leaseToken],
        );
      await client.query("COMMIT");
      return updated.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
      const locked = await client.query<{ current: boolean }>(
        `SELECT (j."type" = 'RENDER_VERTICAL' AND j."payloadVersion" = 1
                 AND j."recipeVersion" = 'vertical-render-v1'
                 AND j."verticalRenderIntentId" = i."id"
                 AND i."renderContractVersion" = 'vertical-render-v1'
                 AND i."framingMode" = 'CENTER_CROP'
                 AND s."sourceVersion" = j."sourceVersion" AND s."status" = 'READY'
                 AND sa."status" = 'CLEARED'
                 AND i."projectId" = j."projectId" AND i."sourceId" = j."sourceId"
                 AND i."sourceVersion" = j."sourceVersion"
                 AND i."cutResultArtifactId" = a."id"
                 AND cut."type" = 'CUT_SEGMENT' AND cut."state" = 'READY'
                 AND a."status" = 'READY' AND a."role" = 'CUT_RESULT'
                 AND a."contentType" = 'video/mp4'
                 AND a."projectId" = j."projectId" AND a."lineageSourceId" = j."sourceId"
                 AND a."lineageSourceVersion" = j."sourceVersion"
                 AND a."pipelineJobId" = i."cutPipelineJobId"
                 AND i."outputWidth" = 1080 AND i."outputHeight" = 1920) AS "current"
           FROM "PipelineJob" j
           JOIN "VerticalRenderIntent" i ON i."id" = j."verticalRenderIntentId"
           JOIN "MediaArtifact" a ON a."id" = i."cutResultArtifactId"
           JOIN "PipelineJob" cut ON cut."id" = i."cutPipelineJobId"
           JOIN "VideoSource" s ON s."id" = j."sourceId"
           JOIN "SourceAuthorization" sa ON sa."sourceId" = j."sourceId"
             AND sa."sourceVersion" = j."sourceVersion"
          WHERE j."id"=$1 AND j."state"='PROCESSING'
            AND j."leaseToken"=$2 AND j."leaseExpiresAt">now()
          FOR UPDATE OF j`,
        [claim.jobId, claim.leaseToken],
      );
      if (!locked.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      if (!locked.rows[0]?.current) {
        await client.query(
          `UPDATE "PipelineJob" SET "state"='FAILED_FINAL',
             "failureCode"='VERTICAL_LINEAGE_STALE',
             "failureMessage"='Vertical input lineage is no longer current.',
             "failureRetryable"=false, "finishedAt"=now(), "leaseOwner"=NULL,
             "leaseToken"=NULL, "leaseExpiresAt"=NULL, "updatedAt"=now()
           WHERE "id"=$1`,
          [claim.jobId],
        );
        await client.query(
          `UPDATE "JobAttempt" SET "state"='FAILED_FINAL',
             "failureCode"='VERTICAL_LINEAGE_STALE', "finishedAt"=now(),
             "updatedAt"=now()
           WHERE "jobId"=$1 AND "attemptNumber"=$2 AND "leaseToken"=$3`,
          [claim.jobId, claim.attemptNumber, claim.leaseToken],
        );
        await client.query("COMMIT");
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
          "cleanupStatus"='NOT_REQUIRED', "cleanupLastErrorCode"=NULL,
          "cleanupCompletedAt"=NULL, "updatedAt"=now()
          WHERE "jobId"=$1 AND "attemptNumber"=$2 AND "leaseToken"=$3`,
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

  async prepareOutput(
    claim: VerticalRenderClaim,
    objectKey: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE "JobAttempt" a
          SET "outputObjectKey"=$4, "cleanupStatus"='PENDING',
              "cleanupLastErrorCode"=NULL, "cleanupRequestedAt"=now(),
              "cleanupCompletedAt"=NULL, "updatedAt"=now()
         FROM "PipelineJob" j
        WHERE a."jobId"=$1 AND a."attemptNumber"=$2 AND a."leaseToken"=$3
          AND (a."outputObjectKey" IS NULL OR a."outputObjectKey"=$4)
          AND j."id"=a."jobId" AND j."state"='PROCESSING'
          AND j."leaseToken"=$3 AND j."leaseExpiresAt">now()`,
      [claim.jobId, claim.attemptNumber, claim.leaseToken, objectKey],
    );
    if (result.rowCount !== 1) throw new Error("VERTICAL_LEASE_LOST");
  }

  async completionMatches(
    claim: VerticalRenderClaim,
    output: { objectKey: string; sizeBytes: bigint; sha256: string },
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM "PipelineJob" j
         JOIN "MediaArtifact" a ON a."pipelineJobId"=j."id"
         JOIN "VerticalRenderResult" r ON r."pipelineJobId"=j."id"
          AND r."artifactId"=a."id" AND r."intentId"=j."verticalRenderIntentId"
        WHERE j."id"=$1 AND j."verticalRenderIntentId"=$2
          AND j."state"='READY' AND a."status"='READY'
          AND a."objectKey"=$3 AND a."sizeBytes"=$4::bigint AND a."sha256"=$5
          AND r."sizeBytes"=$4::bigint AND r."sha256"=$5`,
      [
        claim.jobId,
        claim.intentId,
        output.objectKey,
        output.sizeBytes.toString(),
        output.sha256,
      ],
    );
    return result.rowCount === 1;
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
         WHERE "id"=$1 AND "state"='PROCESSING' AND "leaseToken"=$2
           AND "leaseExpiresAt">now()`,
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
