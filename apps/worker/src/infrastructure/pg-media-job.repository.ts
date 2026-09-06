import { randomUUID } from "node:crypto";
import type { MontageProbeResultV1 } from "@content-factory/contracts";

import { Pool, type PoolClient } from "pg";

import type { MediaJobRepository } from "../application/ports.js";
import {
  ControlledMediaError,
  type ClaimedMediaJob,
} from "../domain/media-job.js";

interface ClaimRow {
  id: string;
  type: ClaimedMediaJob["type"];
  state: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceObjectKey: string;
  sourceSizeBytes: string;
  sourceSha256: string;
  originalFilename: string;
  attemptCount: number;
  retryBudget: number;
  recipeVersion: string;
  leaseExpiresAt: Date | null;
  queuedAt: Date;
  jobStartedAt: Date | null;
  clientSegmentId: string | null;
  startMs: number | null;
  endMs: number | null;
  montageAssetId: string | null;
}

export class PgMediaJobRepository implements MediaJobRepository {
  private readonly pool: Pool;

  constructor(
    connectionString: string,
    private readonly sourceAuthorizationPolicy:
      "manual" | "local-auto" = "manual",
  ) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  async claim(
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedMediaJob | null> {
    return this.transaction(async (client) => {
      const selected = await client.query<ClaimRow>(
        `SELECT j."id", j."type", j."state", j."projectId", j."sourceId",
                j."attemptCount", j."retryBudget", j."recipeVersion", j."leaseExpiresAt",
                j."queuedAt", j."startedAt" AS "jobStartedAt",
                j."sourceVersion", j."montageAssetId", COALESCE(m."originalFilename", s."originalFilename") AS "originalFilename",
                COALESCE(m."sha256", a."sha256") AS "sourceSha256",
                COALESCE(m."objectKey", a."objectKey") AS "sourceObjectKey", COALESCE(m."sizeBytes", a."sizeBytes")::text AS "sourceSizeBytes",
                c."clientSegmentId", c."startMs", c."endMs"
           FROM "PipelineJob" j
           JOIN "VideoSource" s ON s."id" = j."sourceId" AND s."projectId" = j."projectId" AND s."sourceVersion" = j."sourceVersion" AND s."status" = 'READY'
           JOIN "SourceAuthorization" auth
             ON auth."sourceId" = s."id"
            AND auth."sourceVersion" = j."sourceVersion"
            AND auth."status" = 'CLEARED'
            AND (
              auth."basis" IN ('LEGACY_ATTESTATION', 'OPERATOR_ATTESTATION')
              OR (auth."basis" = 'LOCAL_DEVELOPMENT_AUTO' AND $2 = 'local-auto')
            )
            AND auth."declarationVersion" IS NOT NULL
            AND auth."decidedAt" IS NOT NULL
      LEFT JOIN "MediaArtifact" a ON a."sourceId" = s."id"
            AND a."lineageSourceVersion" = j."sourceVersion"
            AND a."role" = 'SOURCE' AND a."status" = 'READY'
            AND j."type" IN ('SOURCE_PROBE','CUT_SEGMENT')
      LEFT JOIN "MontageAsset" m ON m."id" = j."montageAssetId"
            AND m."projectId" = j."projectId" AND m."sourceId" = j."sourceId" AND m."sourceVersion" = j."sourceVersion"
            AND m."status" = 'PROBE_PENDING' AND m."kind" <> 'BANNER'
            AND m."rightsBasis" = 'LOCAL_DEVELOPMENT_AUTO' AND m."rightsDeclaration" = 'montage-local-development-auto-v1'
            AND m."rightsDecidedAt" IS NOT NULL AND $2 = 'local-auto'
      LEFT JOIN "CutSegment" c ON c."jobId" = j."id"
          WHERE j."id" = $1 AND j."payloadVersion" = 1
            AND ((j."type" IN ('SOURCE_PROBE','CUT_SEGMENT') AND a."id" IS NOT NULL AND j."montageAssetId" IS NULL)
              OR (j."type" = 'MONTAGE_ASSET_PROBE' AND m."id" IS NOT NULL AND j."recipeVersion" = 'montage-asset-probe-v1'))
          FOR UPDATE OF j`,
        [jobId, this.sourceAuthorizationPolicy],
      );
      const row = selected.rows[0];
      if (!row || row.state === "READY" || row.state === "FAILED_FINAL")
        return null;
      if (row.state === "PROCESSING") return null;
      const attemptNumber = row.attemptCount + 1;
      if (attemptNumber > row.retryBudget + 1) {
        await client.query(
          `UPDATE "PipelineJob" SET "state"='FAILED_FINAL', "failureCode"='RETRY_BUDGET_EXHAUSTED',
                  "failureMessage"='Исчерпан лимит повторных попыток обработки.', "failureRetryable"=false,
                  "finishedAt"=now(), "revision"="revision"+1, "updatedAt"=now()
            WHERE "id"=$1`,
          [jobId],
        );
        if (row.type === "MONTAGE_ASSET_PROBE")
          await client.query(
            `UPDATE "MontageAsset" SET "status"='FAILED_FINAL', "failureCode"='RETRY_BUDGET_EXHAUSTED', "failureMessage"='Probe retry budget exhausted.', "cleanupStatus"='PENDING', "revision"="revision"+1, "updatedAt"=now() WHERE "id"=$1 AND "status"='PROBE_PENDING'`,
            [row.montageAssetId],
          );
        return null;
      }
      const leaseToken = randomUUID();
      const attempt = await client.query<{ startedAt: Date }>(
        `INSERT INTO "JobAttempt" ("id","jobId","attemptNumber","state","workerId","leaseToken","startedAt","heartbeatAt","updatedAt")
         VALUES ($1,$2,$3,'PROCESSING',$4,$5,now(),now(),now())
         ON CONFLICT ("jobId","attemptNumber") DO UPDATE SET
           "state"='PROCESSING', "workerId"=EXCLUDED."workerId", "leaseToken"=EXCLUDED."leaseToken",
           "startedAt"=COALESCE("JobAttempt"."startedAt",now()), "heartbeatAt"=now(), "updatedAt"=now()
         RETURNING "startedAt"`,
        [randomUUID(), jobId, attemptNumber, workerId, leaseToken],
      );
      await client.query(
        `UPDATE "PipelineJob" SET "state"='PROCESSING', "attemptCount"=$2, "leaseOwner"=$3,
                "leaseToken"=$4, "leaseExpiresAt"=now()+($5*interval '1 millisecond'),
                "heartbeatAt"=now(), "startedAt"=COALESCE("startedAt",now()),
                "failureCode"=NULL, "failureMessage"=NULL, "failureRetryable"=NULL,
                "revision"="revision"+1, "updatedAt"=now()
          WHERE "id"=$1`,
        [jobId, attemptNumber, workerId, leaseToken, leaseMs],
      );
      return {
        id: row.id,
        ...(row.type === "MONTAGE_ASSET_PROBE"
          ? { type: row.type, montageAssetId: row.montageAssetId! }
          : { type: row.type }),
        projectId: row.projectId,
        sourceId: row.sourceId,
        sourceVersion: row.sourceVersion,
        sourceObjectKey: row.sourceObjectKey,
        sourceSizeBytes: BigInt(row.sourceSizeBytes),
        sourceSha256: row.sourceSha256,
        originalFilename: row.originalFilename,
        leaseToken,
        attemptNumber,
        queueWaitMs: Math.max(
          0,
          (row.jobStartedAt?.getTime() ??
            attempt.rows[0]?.startedAt.getTime() ??
            row.queuedAt.getTime()) - row.queuedAt.getTime(),
        ),
        retryBudget: row.retryBudget,
        recipeVersion: row.recipeVersion,
        ...(row.clientSegmentId && row.startMs !== null && row.endMs !== null
          ? {
              segment: {
                clientSegmentId: row.clientSegmentId,
                startMs: row.startMs,
                endMs: row.endMs,
              },
            }
          : {}),
      };
    });
  }

  async heartbeat(
    jobId: string,
    leaseToken: string,
    leaseMs: number,
    processedMs?: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "PipelineJob" SET "heartbeatAt"=now(), "leaseExpiresAt"=now()+($3*interval '1 millisecond'),
              "processedMs"=COALESCE($4,"processedMs"), "revision"="revision"+1, "updatedAt"=now()
        WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING'
          AND "leaseExpiresAt">now()`,
      [jobId, leaseToken, leaseMs, processedMs ?? null],
    );
    if (result.rowCount === 1) {
      await this.pool.query(
        `UPDATE "JobAttempt" SET "heartbeatAt"=now(), "updatedAt"=now()
          WHERE "jobId"=$1 AND "attemptNumber"=(SELECT "attemptCount" FROM "PipelineJob" WHERE "id"=$1)`,
        [jobId],
      );
      return true;
    }
    return false;
  }

  async isLeaseActive(job: ClaimedMediaJob): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM "PipelineJob"
        WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING'
          AND "leaseExpiresAt">now()`,
      [job.id, job.leaseToken],
    );
    return result.rowCount === 1;
  }

  async prepareAttemptOutput(
    job: ClaimedMediaJob,
    objectKey: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertLease(client, job);
      const updated = await client.query(
        `UPDATE "JobAttempt"
            SET "outputObjectKey"=$3, "cleanupStatus"='PENDING',
                "cleanupLastErrorCode"=NULL, "cleanupRequestedAt"=now(),
                "cleanupCompletedAt"=NULL, "updatedAt"=now()
          WHERE "jobId"=$1 AND "attemptNumber"=$2
            AND ("outputObjectKey" IS NULL OR "outputObjectKey"=$3)`,
        [job.id, job.attemptNumber, objectKey],
      );
      if (updated.rowCount !== 1) throw new Error("ATTEMPT_OUTPUT_CONFLICT");
    });
  }

  async completeAttemptCleanup(
    job: ClaimedMediaJob,
    objectKey: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "JobAttempt"
          SET "cleanupStatus"='COMPLETED', "cleanupLastErrorCode"=NULL,
              "cleanupCompletedAt"=now(), "updatedAt"=now()
        WHERE "jobId"=$1 AND "attemptNumber"=$2
          AND "outputObjectKey"=$3 AND "cleanupStatus"='PENDING'`,
      [job.id, job.attemptNumber, objectKey],
    );
  }

  async completeProbe(
    job: ClaimedMediaJob,
    durationMs: number,
    probeVersion: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertLease(client, job);
      const updated = await client.query(
        `UPDATE "VideoSource" SET "durationMs"=$2, "probedAt"=now(), "probeVersion"=$3, "updatedAt"=now()
          WHERE "id"=$1 AND "sourceVersion"=$4`,
        [job.sourceId, durationMs, probeVersion, job.sourceVersion],
      );
      if (updated.rowCount !== 1)
        throw new ControlledMediaError(
          "SOURCE_VERSION_STALE",
          "Версия исходного видео изменилась до завершения проверки.",
          false,
        );
      await this.finishReady(client, job);
    });
  }

  async completeMontageProbe(
    job: ClaimedMediaJob,
    result: MontageProbeResultV1,
  ): Promise<void> {
    if (job.type !== "MONTAGE_ASSET_PROBE" || result.schemaVersion !== 1)
      throw new ControlledMediaError(
        "MONTAGE_PROBE_SCHEMA_INVALID",
        "Invalid montage probe job/result schema.",
        false,
      );
    await this.transaction(async (client) => {
      await this.assertLease(client, job);
      const updated = await client.query(
        `UPDATE "MontageAsset" m
        SET "status"='READY', "durationMs"=$8, "width"=$9, "height"=$10, "hasAudio"=$11,
            "probeVersion"=$12, "probedAt"=now(), "revision"="revision"+1, "updatedAt"=now()
        WHERE m."id"=$1 AND m."projectId"=$2 AND m."sourceId"=$3 AND m."sourceVersion"=$4
          AND m."sha256"=$5 AND m."sizeBytes"=$6 AND m."objectKey"=$7 AND m."status"='PROBE_PENDING'
          AND m."rightsBasis"='LOCAL_DEVELOPMENT_AUTO' AND m."rightsDeclaration"='montage-local-development-auto-v1' AND $13='local-auto'
          AND EXISTS (SELECT 1 FROM "PipelineJob" j WHERE j."id"=$14 AND j."montageAssetId"=m."id" AND j."type"='MONTAGE_ASSET_PROBE')
          AND EXISTS (SELECT 1 FROM "SourceAuthorization" a JOIN "VideoSource" s ON s."id"=a."sourceId"
            WHERE a."sourceId"=m."sourceId" AND a."sourceVersion"=m."sourceVersion" AND s."sourceVersion"=m."sourceVersion"
            AND a."status"='CLEARED' AND a."basis" IS NOT NULL AND a."declarationVersion" IS NOT NULL AND a."decidedAt" IS NOT NULL)`,
        [
          job.montageAssetId,
          job.projectId,
          job.sourceId,
          job.sourceVersion,
          job.sourceSha256,
          job.sourceSizeBytes.toString(),
          job.sourceObjectKey,
          result.durationMs,
          result.width,
          result.height,
          result.hasAudio,
          result.version,
          this.sourceAuthorizationPolicy,
          job.id,
        ],
      );
      if (updated.rowCount !== 1)
        throw new ControlledMediaError(
          "MONTAGE_IDENTITY_CONFLICT",
          "Montage identity or authorization changed before finalization.",
          false,
        );
      await this.finishReady(client, job);
    });
  }

  async completeCut(
    job: ClaimedMediaJob,
    result: {
      objectKey: string;
      filename: string;
      sizeBytes: bigint;
      sha256: string;
      etag?: string;
      storageVersion?: string;
      ffmpegVersion: string;
    },
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertLease(client, job);
      await client.query(
        `INSERT INTO "MediaArtifact"
          ("id","projectId","sourceId","role","status","objectKey","storageEtag","storageVersion",
           "sizeBytes","sha256","contentType","lineageSourceId","lineageSourceVersion","recipeVersion",
           "pipelineJobId","ffmpegVersion","outputFilename","updatedAt")
         VALUES ($1,$2,$3,'CUT_RESULT','READY',$4,$5,$6,$7,$8,'video/mp4',$3,$9,$10,$11,$12,$13,now())
         ON CONFLICT ("pipelineJobId") DO NOTHING`,
        [
          randomUUID(),
          job.projectId,
          job.sourceId,
          result.objectKey,
          result.etag ?? null,
          result.storageVersion ?? null,
          result.sizeBytes.toString(),
          result.sha256,
          job.sourceVersion,
          job.recipeVersion,
          job.id,
          result.ffmpegVersion,
          result.filename,
        ],
      );
      const artifact = await client.query<{
        sha256: string;
        objectKey: string;
      }>(
        `SELECT "sha256","objectKey" FROM "MediaArtifact" WHERE "pipelineJobId"=$1`,
        [job.id],
      );
      if (
        artifact.rows[0]?.sha256 !== result.sha256 ||
        artifact.rows[0]?.objectKey !== result.objectKey
      ) {
        throw new Error("RESULT_ARTIFACT_CONFLICT");
      }
      await client.query(
        `UPDATE "JobAttempt"
            SET "cleanupStatus"='NOT_REQUIRED', "cleanupLastErrorCode"=NULL,
                "cleanupCompletedAt"=NULL, "updatedAt"=now()
          WHERE "jobId"=$1 AND "attemptNumber"=$2
            AND "outputObjectKey"=$3`,
        [job.id, job.attemptNumber, result.objectKey],
      );
      await this.finishReady(client, job);
    });
  }

  async fail(
    job: ClaimedMediaJob,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<"RETRY_SCHEDULED" | "FAILED_FINAL" | "LEASE_LOST"> {
    return this.transaction(async (client) => {
      const retryScheduled = retryable && job.attemptNumber <= job.retryBudget;
      const state = retryScheduled ? "RETRY_WAIT" : "FAILED_FINAL";
      const attemptState = retryScheduled ? "FAILED_RETRYABLE" : "FAILED_FINAL";
      const result = await client.query(
        `UPDATE "PipelineJob" SET "state"=$3::"PipelineJobState", "failureCode"=$4, "failureMessage"=$5,
                "failureRetryable"=$6, "leaseOwner"=NULL, "leaseToken"=NULL, "leaseExpiresAt"=NULL,
                "heartbeatAt"=NULL, "finishedAt"=CASE WHEN $3='FAILED_FINAL' THEN now() ELSE NULL END,
                "revision"="revision"+1, "updatedAt"=now()
          WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING'`,
        [job.id, job.leaseToken, state, code, message, retryScheduled],
      );
      if (result.rowCount !== 1) return "LEASE_LOST";
      if (!retryScheduled && job.type === "MONTAGE_ASSET_PROBE") {
        await client.query(
          `UPDATE "MontageAsset" SET "status"='FAILED_FINAL', "failureCode"=$2, "failureMessage"=$3, "cleanupStatus"='PENDING', "revision"="revision"+1, "updatedAt"=now() WHERE "id"=$1 AND "status"='PROBE_PENDING'`,
          [job.montageAssetId, code, message],
        );
      }
      await client.query(
        `UPDATE "JobAttempt" SET "state"=$3::"JobAttemptState", "failureCode"=$4, "finishedAt"=now(), "updatedAt"=now()
          WHERE "jobId"=$1 AND "attemptNumber"=$2`,
        [job.id, job.attemptNumber, attemptState, code],
      );
      return retryScheduled ? "RETRY_SCHEDULED" : "FAILED_FINAL";
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async assertLease(
    client: PoolClient,
    job: ClaimedMediaJob,
  ): Promise<void> {
    const lease = await client.query(
      `SELECT 1 FROM "PipelineJob"
        WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING'
          AND "leaseExpiresAt">now()
        FOR UPDATE`,
      [job.id, job.leaseToken],
    );
    if (lease.rowCount !== 1) throw new Error("JOB_LEASE_LOST");
  }

  private async finishReady(
    client: PoolClient,
    job: ClaimedMediaJob,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE "PipelineJob" SET "state"='READY', "processedMs"="totalMs", "leaseOwner"=NULL,
              "leaseToken"=NULL, "leaseExpiresAt"=NULL, "heartbeatAt"=NULL, "finishedAt"=now(),
              "failureCode"=NULL, "failureMessage"=NULL, "failureRetryable"=NULL,
              "revision"="revision"+1, "updatedAt"=now()
        WHERE "id"=$1 AND "leaseToken"=$2`,
      [job.id, job.leaseToken],
    );
    if (result.rowCount !== 1) throw new Error("JOB_LEASE_LOST");
    await client.query(
      `UPDATE "JobAttempt" SET "state"='READY', "finishedAt"=now(), "updatedAt"=now()
        WHERE "jobId"=$1 AND "attemptNumber"=$2`,
      [job.id, job.attemptNumber],
    );
  }

  private async transaction<T>(
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
