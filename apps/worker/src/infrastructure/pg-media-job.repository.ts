import { createHash, randomUUID } from "node:crypto";
import type { MontageProbeResultV1 } from "@content-factory/contracts";

import { Pool, type PoolClient } from "pg";

import type { MediaJobRepository } from "../application/ports.js";
import {
  ControlledMediaError,
  type ClaimedMediaJob,
} from "../domain/media-job.js";

interface ClaimRow {
  id: string;
  type: "SOURCE_PROBE" | "CUT_SEGMENT" | "MONTAGE_ASSET_PROBE";
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

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

interface AssemblyClaimRow {
  id: string;
  state: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  attemptCount: number;
  retryBudget: number;
  recipeVersion: string;
  queuedAt: Date;
  jobStartedAt: Date | null;
  intentId: string;
  recipeRevisionId: string;
  recipeRevision: number;
  configurationFingerprint: string;
  renderContractVersion: string;
  audioProfileVersion: string;
  encodingProfileVersion: string;
  expectedDurationMs: number;
  advertisementInsertAtMs: number | null;
  ctaText: string | null;
  ctaStartMs: number | null;
  ctaEndMs: number | null;
  ctaPosition: "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT" | null;
  cutArtifactId: string;
  cutObjectKey: string;
  cutSizeBytes: string;
  cutSha256: string;
  cutDurationMs: number;
}

interface ExportClaimRow {
  id: string;
  state: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  attemptCount: number;
  retryBudget: number;
  recipeVersion: string;
  queuedAt: Date;
  jobStartedAt: Date | null;
  intentId: string;
  approvalId: string;
  approvalContractVersion: string;
  exportContractVersion: string;
  candidateFingerprint: string;
  editorialPackageRevisionId: string;
  editorialRevision: number;
  processingTemplateRevisionId: string;
  recipeRevisionId: string;
  recipeRevision: number;
  configurationFingerprint: string;
  assemblyRenderResultId: string;
  renderContractVersion: string;
  videoArtifactId: string;
  videoObjectKey: string;
  videoSizeBytes: string;
  videoSha256: string;
  thumbnailAssetId: string;
  thumbnailObjectKey: string;
  thumbnailSizeBytes: string;
  thumbnailSha256: string;
  thumbnailContentType: "image/jpeg" | "image/png" | "image/webp";
  thumbnailOriginalFilename: string;
  title: string;
  description: string;
  tags: unknown;
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

  async getAssemblyResourcePlan(
    jobId: string,
  ): Promise<{ requiredScratchBytes: bigint } | null> {
    const exportResult = await this.pool.query<{
      videoBytes: string;
      thumbnailBytes: string;
    }>(
      `SELECT a."renderArtifactSizeBytes"::text AS "videoBytes",
              a."thumbnailSizeBytes"::text AS "thumbnailBytes"
         FROM "PipelineJob" j
         JOIN "EditorialExportIntent" e ON e."id"=j."editorialExportIntentId"
         JOIN "EditorialApproval" a ON a."id"=e."approvalId" AND a."projectId"=e."projectId"
        WHERE j."id"=$1 AND j."type"='EXPORT_EDITORIAL_PACKAGE'
          AND ((j."state"='QUEUED' AND (j."nextAttemptAt" IS NULL OR j."nextAttemptAt"<=now()))
            OR (j."state"='RETRY_WAIT' AND j."nextAttemptAt"<=now()))`,
      [jobId],
    );
    const exportRow = exportResult.rows[0];
    if (exportRow) {
      return {
        requiredScratchBytes:
          BigInt(exportRow.videoBytes) +
          BigInt(exportRow.thumbnailBytes) +
          2n * 1024n * 1024n,
      };
    }
    const result = await this.pool.query<{
      cutBytes: string;
      assetBytes: string;
      expectedDurationMs: number;
    }>(
      `SELECT i."cutResultSizeBytes"::text AS "cutBytes",
              COALESCE(sum(ref."assetSizeBytes"),0)::text AS "assetBytes",
              i."expectedDurationMs"
         FROM "PipelineJob" j
         JOIN "AssemblyRenderIntent" i ON i."id"=j."assemblyRenderIntentId"
    LEFT JOIN "AssemblyRecipeAssetReference" ref ON ref."recipeRevisionId"=i."recipeRevisionId"
        WHERE j."id"=$1 AND j."type"='ASSEMBLE_HORIZONTAL'
          AND ((j."state"='QUEUED' AND (j."nextAttemptAt" IS NULL OR j."nextAttemptAt"<=now()))
            OR (j."state"='RETRY_WAIT' AND j."nextAttemptAt"<=now()))
        GROUP BY i."cutResultSizeBytes", i."expectedDurationMs"`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const inputs = BigInt(row.cutBytes) + BigInt(row.assetBytes);
    const encodedEstimate =
      (BigInt(row.expectedDurationMs) * 2_000_000n) / 1_000n;
    return {
      requiredScratchBytes:
        inputs +
        (encodedEstimate > BigInt(row.cutBytes) * 2n
          ? encodedEstimate
          : BigInt(row.cutBytes) * 2n) +
        64n * 1024n * 1024n,
    };
  }

  async deferAssemblyAdmission(
    jobId: string,
    reason: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "PipelineJob" SET "admissionReason"=$2, "nextAttemptAt"=$3,
              "revision"="revision"+1, "updatedAt"=now()
        WHERE "id"=$1 AND "type" IN ('ASSEMBLE_HORIZONTAL','EXPORT_EDITORIAL_PACKAGE')
          AND "state" IN ('QUEUED','RETRY_WAIT')`,
      [jobId, reason.slice(0, 120), nextAttemptAt],
    );
  }

  async prepareExportScratch(
    job: ClaimedMediaJob,
    marker: {
      directoryName: string;
      leaseHash: string;
      reservedBytes: bigint;
    },
  ): Promise<void> {
    if (job.type !== "EXPORT_EDITORIAL_PACKAGE")
      throw new ControlledMediaError(
        "EXPORT_JOB_TYPE_INVALID",
        "Invalid editorial export job type.",
        false,
      );
    await this.transaction(async (client) => {
      await this.assertLease(client, job);
      const result = await client.query(
        `UPDATE "JobAttempt" SET "scratchDirectoryName"=$3,
                "scratchLeaseHash"=$4, "scratchReservedBytes"=$5,
                "scratchCreatedAt"=COALESCE("scratchCreatedAt",now()), "updatedAt"=now()
          WHERE "jobId"=$1 AND "attemptNumber"=$2
            AND ("scratchDirectoryName" IS NULL OR "scratchDirectoryName"=$3)
            AND ("scratchLeaseHash" IS NULL OR "scratchLeaseHash"=$4)`,
        [
          job.id,
          job.attemptNumber,
          marker.directoryName,
          marker.leaseHash,
          marker.reservedBytes.toString(),
        ],
      );
      if (result.rowCount !== 1) throw new Error("EXPORT_SCRATCH_CONFLICT");
    });
  }

  async clearExportScratch(
    job: ClaimedMediaJob,
    directoryName: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "JobAttempt" SET "scratchDirectoryName"=NULL,
              "scratchLeaseHash"=NULL, "scratchReservedBytes"=NULL,
              "scratchCreatedAt"=NULL, "updatedAt"=now()
        WHERE "jobId"=$1 AND "attemptNumber"=$2 AND "scratchDirectoryName"=$3`,
      [job.id, job.attemptNumber, directoryName],
    );
  }

  async listActiveExportScratchReservations(): Promise<
    Array<{
      jobId: string;
      attemptNumber: number;
      directoryName: string;
      leaseHash: string;
      reservedBytes: bigint;
    }>
  > {
    const result = await this.pool.query<{
      jobId: string;
      attemptNumber: number;
      directoryName: string;
      leaseHash: string;
      reservedBytes: string;
    }>(
      `SELECT a."jobId", a."attemptNumber",
              a."scratchDirectoryName" AS "directoryName",
              a."scratchLeaseHash" AS "leaseHash",
              a."scratchReservedBytes"::text AS "reservedBytes"
         FROM "JobAttempt" a
         JOIN "PipelineJob" j ON j."id"=a."jobId"
        WHERE j."type"='EXPORT_EDITORIAL_PACKAGE' AND j."state"='PROCESSING'
          AND j."attemptCount"=a."attemptNumber" AND j."leaseToken"=a."leaseToken"
          AND j."leaseToken" IS NOT NULL AND j."leaseExpiresAt">now()
          AND a."state"='PROCESSING' AND a."scratchDirectoryName" IS NOT NULL
          AND a."scratchLeaseHash" IS NOT NULL AND a."scratchReservedBytes" IS NOT NULL`,
    );
    return result.rows.map((row) => ({
      ...row,
      reservedBytes: BigInt(row.reservedBytes),
    }));
  }

  async inspectExportScratchLease(input: {
    jobId: string;
    attemptNumber: number;
    leaseHash: string;
    directoryName: string;
  }): Promise<"ACTIVE" | "INACTIVE" | "UNKNOWN"> {
    try {
      const result = await this.pool.query<{
        state: string;
        leaseToken: string | null;
        leaseUnexpired: boolean;
      }>(
        `SELECT j."state", j."leaseToken",
                (j."leaseExpiresAt" IS NOT NULL AND j."leaseExpiresAt">now()) AS "leaseUnexpired"
           FROM "JobAttempt" a
           JOIN "PipelineJob" j ON j."id"=a."jobId"
          WHERE a."jobId"=$1 AND a."attemptNumber"=$2
            AND a."scratchDirectoryName"=$3 AND a."scratchLeaseHash"=$4`,
        [
          input.jobId,
          input.attemptNumber,
          input.directoryName,
          input.leaseHash,
        ],
      );
      const row = result.rows[0];
      return row &&
        row.state === "PROCESSING" &&
        row.leaseUnexpired &&
        row.leaseToken !== null &&
        createHash("sha256").update(row.leaseToken).digest("hex") ===
          input.leaseHash
        ? "ACTIVE"
        : "INACTIVE";
    } catch {
      return "UNKNOWN";
    }
  }

  async clearReconciledExportScratch(input: {
    jobId: string;
    attemptNumber: number;
    directoryName: string;
    leaseHash: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE "JobAttempt" SET "scratchDirectoryName"=NULL,
              "scratchLeaseHash"=NULL, "scratchReservedBytes"=NULL,
              "scratchCreatedAt"=NULL, "updatedAt"=now()
        WHERE "jobId"=$1 AND "attemptNumber"=$2
          AND "scratchDirectoryName"=$3 AND "scratchLeaseHash"=$4`,
      [input.jobId, input.attemptNumber, input.directoryName, input.leaseHash],
    );
  }

  async claim(
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedMediaJob | null> {
    return this.transaction(async (client) => {
      const kind = await client.query<{ type: string }>(
        `SELECT "type"::text AS "type" FROM "PipelineJob" WHERE "id"=$1`,
        [jobId],
      );
      if (kind.rows[0]?.type === "ASSEMBLE_HORIZONTAL") {
        return this.claimAssembly(client, jobId, workerId, leaseMs);
      }
      if (kind.rows[0]?.type === "EXPORT_EDITORIAL_PACKAGE") {
        return this.claimExport(client, jobId, workerId, leaseMs);
      }
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
            AND ((j."state"='QUEUED' AND (j."nextAttemptAt" IS NULL OR j."nextAttemptAt"<=now()))
              OR (j."state"='RETRY_WAIT' AND j."nextAttemptAt"<=now()))
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
                  "finishedAt"=now(), "nextAttemptAt"=NULL, "revision"="revision"+1, "updatedAt"=now()
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
                "heartbeatAt"=now(), "startedAt"=COALESCE("startedAt",now()), "nextAttemptAt"=NULL,
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

  async updateAssemblyProgress(
    job: ClaimedMediaJob,
    phase:
      | "DOWNLOAD"
      | "READ_INPUTS"
      | "WRITE_ARCHIVE"
      | "AUDIO_ANALYSIS"
      | "ENCODE"
      | "OUTPUT_PROBE"
      | "OUTPUT_HASH"
      | "UPLOAD"
      | "FINALIZE",
    basisPoints: number,
  ): Promise<boolean> {
    if (
      job.type !== "ASSEMBLE_HORIZONTAL" &&
      job.type !== "EXPORT_EDITORIAL_PACKAGE"
    )
      return false;
    const bounded = Math.max(0, Math.min(10_000, Math.round(basisPoints)));
    const result = await this.pool.query(
      `UPDATE "PipelineJob"
          SET "progressAttemptNumber"=$3, "progressPhase"=$4::"AssemblyProgressPhase",
              "progressBasisPoints"=GREATEST(COALESCE("progressBasisPoints",0),$5),
              "progressUpdatedAt"=now(), "revision"="revision"+1, "updatedAt"=now()
        WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING'
          AND "leaseExpiresAt">now()
          AND ("progressAttemptNumber" IS NULL OR "progressAttemptNumber"=$3)`,
      [job.id, job.leaseToken, job.attemptNumber, phase, bounded],
    );
    return result.rowCount === 1;
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

  async completeAssembly(
    job: ClaimedMediaJob,
    result: {
      objectKey: string;
      filename: string;
      sizeBytes: bigint;
      sha256: string;
      etag?: string;
      storageVersion?: string;
      durationMs: number;
      width: number;
      height: number;
      fpsNumerator: number;
      fpsDenominator: number;
      videoCodec: string;
      pixelFormat: string;
      audioCodec: string;
      audioSampleRate: number;
      audioChannels: number;
      ffmpegVersion: string;
      ffprobeVersion: string;
      integratedLoudnessLufs: number | null;
      truePeakDbtp: number | null;
      normalizationProfileResult: string;
    },
  ): Promise<void> {
    if (job.type !== "ASSEMBLE_HORIZONTAL") {
      throw new ControlledMediaError(
        "ASSEMBLY_JOB_TYPE_INVALID",
        "Invalid assembly job type.",
        false,
      );
    }
    await this.transaction(async (client) => {
      await this.assertLease(client, job);
      const identity = await client.query<{ intentId: string }>(
        `SELECT i."id" AS "intentId"
           FROM "AssemblyRenderIntent" i
           JOIN "PipelineJob" j ON j."assemblyRenderIntentId"=i."id"
            AND j."projectId"=i."projectId" AND j."sourceId"=i."sourceId" AND j."sourceVersion"=i."sourceVersion"
           JOIN "VideoSource" s ON s."id"=i."sourceId" AND s."projectId"=i."projectId"
            AND s."sourceVersion"=i."sourceVersion" AND s."status"='READY'
           JOIN "SourceAuthorization" auth ON auth."sourceId"=s."id" AND auth."sourceVersion"=s."sourceVersion"
            AND auth."status"='CLEARED' AND auth."basis" IS NOT NULL
            AND auth."declarationVersion" IS NOT NULL AND auth."decidedAt" IS NOT NULL
            AND (auth."basis" IN ('LEGACY_ATTESTATION','OPERATOR_ATTESTATION')
              OR (auth."basis"='LOCAL_DEVELOPMENT_AUTO' AND $6='local-auto'))
           JOIN "MediaArtifact" cut ON cut."id"=i."cutResultArtifactId"
            AND cut."pipelineJobId"=i."cutPipelineJobId" AND cut."projectId"=i."projectId"
            AND cut."lineageSourceId"=i."sourceId" AND cut."lineageSourceVersion"=i."sourceVersion"
            AND cut."role"='CUT_RESULT' AND cut."status"='READY'
            AND cut."sha256"=i."cutResultSha256" AND cut."sizeBytes"=i."cutResultSizeBytes"
            AND cut."recipeVersion"=i."cutResultRecipeVersion"
           JOIN "AssemblyRecipeRevision" revision ON revision."id"=i."recipeRevisionId"
            AND revision."recipeId"=i."assemblyRecipeId" AND revision."revision"=i."recipeRevision"
          WHERE j."id"=$1 AND i."id"=$2 AND i."recipeRevisionId"=$3
            AND i."configurationFingerprint"=$4 AND i."expectedDurationMs"=$5
            AND i."renderContractVersion"='horizontal-render-v1'
            AND revision."configurationFingerprint"=i."configurationFingerprint"
            AND revision."schemaVersion"='horizontal-assembly-v1'
            AND revision."audioProfileVersion"=i."audioProfileVersion"
            AND revision."encodingProfileVersion"=i."encodingProfileVersion"
            AND NOT EXISTS (
              SELECT 1
                FROM "AssemblyRecipeAssetReference" ref
           LEFT JOIN "MontageAsset" asset ON asset."id"=ref."assetId"
                AND asset."projectId"=i."projectId" AND asset."sourceId"=i."sourceId"
                AND asset."sourceVersion"=i."sourceVersion" AND asset."status"='READY'
                AND asset."revision"=ref."assetRevision" AND asset."sha256"=ref."assetSha256"
                AND asset."sizeBytes"=ref."assetSizeBytes" AND asset."kind"=ref."assetKind"
                AND asset."durationMs" IS NOT DISTINCT FROM ref."assetDurationMs"
                AND asset."rightsBasis"='LOCAL_DEVELOPMENT_AUTO'
                AND asset."rightsDeclaration"='montage-local-development-auto-v1'
                AND asset."rightsDecidedAt" IS NOT NULL AND $6='local-auto'
               WHERE ref."recipeRevisionId"=i."recipeRevisionId" AND asset."id" IS NULL
            )`,
        [
          job.id,
          job.assemblyRenderPlan.intentId,
          job.assemblyRenderPlan.recipeRevisionId,
          job.assemblyRenderPlan.configurationFingerprint,
          job.assemblyRenderPlan.expectedDurationMs,
          this.sourceAuthorizationPolicy,
        ],
      );
      if (!identity.rows[0]) {
        throw new ControlledMediaError(
          "ASSEMBLY_INPUT_INVALID",
          "Входы сборки или права изменились до финализации.",
          false,
        );
      }
      const artifactId = randomUUID();
      await client.query(
        `INSERT INTO "MediaArtifact"
          ("id","projectId","sourceId","role","status","objectKey","storageEtag","storageVersion",
           "sizeBytes","sha256","contentType","lineageSourceId","lineageSourceVersion","recipeVersion",
           "pipelineJobId","ffmpegVersion","outputFilename","updatedAt")
         VALUES ($1,$2,$3,'HORIZONTAL_ASSEMBLY_RESULT','READY',$4,$5,$6,$7,$8,'video/mp4',$3,$9,'horizontal-render-v1',$10,$11,$12,now())
         ON CONFLICT ("pipelineJobId") DO NOTHING`,
        [
          artifactId,
          job.projectId,
          job.sourceId,
          result.objectKey,
          result.etag ?? null,
          result.storageVersion ?? null,
          result.sizeBytes.toString(),
          result.sha256,
          job.sourceVersion,
          job.id,
          result.ffmpegVersion,
          result.filename,
        ],
      );
      const artifact = await client.query<{
        id: string;
        sha256: string;
        objectKey: string;
      }>(
        `SELECT "id","sha256","objectKey" FROM "MediaArtifact" WHERE "pipelineJobId"=$1`,
        [job.id],
      );
      if (
        !artifact.rows[0] ||
        artifact.rows[0].sha256 !== result.sha256 ||
        artifact.rows[0].objectKey !== result.objectKey
      ) {
        throw new ControlledMediaError(
          "ASSEMBLY_RESULT_CONFLICT",
          "Сохранённый результат сборки конфликтует с текущей попыткой.",
          false,
        );
      }
      await client.query(
        `INSERT INTO "AssemblyRenderResult"
          ("id","renderIntentId","artifactId","durationMs","width","height","fpsNumerator","fpsDenominator",
           "videoCodec","pixelFormat","audioCodec","audioSampleRate","audioChannels","ffmpegVersion","ffprobeVersion",
           "integratedLoudnessLufs","truePeakDbtp","normalizationProfileResult","completedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
         ON CONFLICT ("renderIntentId") DO NOTHING`,
        [
          randomUUID(),
          job.assemblyRenderPlan.intentId,
          artifact.rows[0].id,
          result.durationMs,
          result.width,
          result.height,
          result.fpsNumerator,
          result.fpsDenominator,
          result.videoCodec,
          result.pixelFormat,
          result.audioCodec,
          result.audioSampleRate,
          result.audioChannels,
          result.ffmpegVersion,
          result.ffprobeVersion,
          result.integratedLoudnessLufs,
          result.truePeakDbtp,
          result.normalizationProfileResult,
        ],
      );
      const accepted = await client.query<{ artifactId: string }>(
        `SELECT "artifactId" FROM "AssemblyRenderResult" WHERE "renderIntentId"=$1`,
        [job.assemblyRenderPlan.intentId],
      );
      if (accepted.rows[0]?.artifactId !== artifact.rows[0].id) {
        throw new ControlledMediaError(
          "ASSEMBLY_RESULT_CONFLICT",
          "Сохранённый результат сборки конфликтует с текущей попыткой.",
          false,
        );
      }
      await client.query(
        `UPDATE "JobAttempt" SET "cleanupStatus"='NOT_REQUIRED', "cleanupLastErrorCode"=NULL,
             "cleanupCompletedAt"=NULL, "updatedAt"=now()
          WHERE "jobId"=$1 AND "attemptNumber"=$2 AND "outputObjectKey"=$3`,
        [job.id, job.attemptNumber, result.objectKey],
      );
      await client.query(
        `UPDATE "PipelineJob" SET "progressAttemptNumber"=$3, "progressPhase"='FINALIZE',
              "progressBasisPoints"=10000, "progressUpdatedAt"=now()
          WHERE "id"=$1 AND "leaseToken"=$2`,
        [job.id, job.leaseToken, job.attemptNumber],
      );
      await this.finishReady(client, job);
    });
  }

  async isAssemblyResultAccepted(
    job: ClaimedMediaJob,
    objectKey: string,
  ): Promise<boolean> {
    if (job.type !== "ASSEMBLE_HORIZONTAL") return false;
    const accepted = await this.pool.query(
      `SELECT 1
         FROM "PipelineJob" j
         JOIN "AssemblyRenderIntent" i ON i."id"=j."assemblyRenderIntentId"
         JOIN "AssemblyRenderResult" r ON r."renderIntentId"=i."id"
         JOIN "MediaArtifact" a ON a."id"=r."artifactId" AND a."pipelineJobId"=j."id"
        WHERE j."id"=$1 AND j."state"='READY' AND i."id"=$2
          AND a."role"='HORIZONTAL_ASSEMBLY_RESULT' AND a."status"='READY'
          AND a."objectKey"=$3`,
      [job.id, job.assemblyRenderPlan.intentId, objectKey],
    );
    return accepted.rowCount === 1;
  }

  async completeEditorialExport(
    job: ClaimedMediaJob,
    result: {
      objectKey: string;
      filename: string;
      sizeBytes: bigint;
      sha256: string;
      etag?: string;
      storageVersion?: string;
      manifest: unknown;
    },
  ): Promise<void> {
    if (job.type !== "EXPORT_EDITORIAL_PACKAGE")
      throw new ControlledMediaError(
        "EXPORT_JOB_TYPE_INVALID",
        "Invalid editorial export job type.",
        false,
      );
    await this.transaction(async (client) => {
      await this.assertLease(client, job);
      await this.assertExportCurrent(client, job);
      await client.query(
        `INSERT INTO "MediaArtifact"
          ("id","projectId","sourceId","role","status","objectKey","storageEtag","storageVersion",
           "sizeBytes","sha256","contentType","lineageSourceId","lineageSourceVersion","recipeVersion",
           "pipelineJobId","outputFilename","updatedAt")
         VALUES ($1,$2,$3,'EDITORIAL_EXPORT_PACKAGE','READY',$4,$5,$6,$7,$8,'application/zip',$3,$9,
                 'editorial-export-zip-v1',$10,$11,now())
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
          job.id,
          result.filename,
        ],
      );
      const artifact = await client.query<{
        id: string;
        objectKey: string;
        sha256: string;
        sizeBytes: string;
      }>(
        `SELECT "id","objectKey","sha256","sizeBytes"::text
           FROM "MediaArtifact" WHERE "pipelineJobId"=$1`,
        [job.id],
      );
      const acceptedArtifact = artifact.rows[0];
      if (
        !acceptedArtifact ||
        acceptedArtifact.objectKey !== result.objectKey ||
        acceptedArtifact.sha256 !== result.sha256 ||
        BigInt(acceptedArtifact.sizeBytes) !== result.sizeBytes
      ) {
        throw new ControlledMediaError(
          "EXPORT_RESULT_CONFLICT",
          "Stored editorial export conflicts with this attempt.",
          false,
        );
      }
      await client.query(
        `INSERT INTO "EditorialExportResult"
          ("id","exportIntentId","pipelineJobId","artifactId","filename","archiveSizeBytes",
           "archiveSha256","manifest","exportContractVersion","completedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'editorial-export-zip-v1',now())
         ON CONFLICT ("exportIntentId") DO NOTHING`,
        [
          randomUUID(),
          job.editorialExportPlan.intentId,
          job.id,
          acceptedArtifact.id,
          result.filename,
          result.sizeBytes.toString(),
          result.sha256,
          JSON.stringify(result.manifest),
        ],
      );
      const accepted = await client.query<{
        artifactId: string;
        pipelineJobId: string;
      }>(
        `SELECT "artifactId","pipelineJobId" FROM "EditorialExportResult"
          WHERE "exportIntentId"=$1`,
        [job.editorialExportPlan.intentId],
      );
      if (
        accepted.rows[0]?.artifactId !== acceptedArtifact.id ||
        accepted.rows[0]?.pipelineJobId !== job.id
      ) {
        throw new ControlledMediaError(
          "EXPORT_RESULT_CONFLICT",
          "Stored editorial export conflicts with this attempt.",
          false,
        );
      }
      await client.query(
        `UPDATE "JobAttempt" SET "cleanupStatus"='NOT_REQUIRED',
             "cleanupLastErrorCode"=NULL, "cleanupCompletedAt"=NULL, "updatedAt"=now()
          WHERE "jobId"=$1 AND "attemptNumber"=$2 AND "outputObjectKey"=$3`,
        [job.id, job.attemptNumber, result.objectKey],
      );
      await client.query(
        `UPDATE "PipelineJob" SET "progressAttemptNumber"=$3,
              "progressPhase"='FINALIZE', "progressBasisPoints"=10000,
              "progressUpdatedAt"=now() WHERE "id"=$1 AND "leaseToken"=$2`,
        [job.id, job.leaseToken, job.attemptNumber],
      );
      await this.finishReady(client, job);
    });
  }

  async isEditorialExportResultAccepted(
    job: ClaimedMediaJob,
    objectKey: string,
  ): Promise<boolean> {
    if (job.type !== "EXPORT_EDITORIAL_PACKAGE") return false;
    const accepted = await this.pool.query(
      `SELECT 1 FROM "PipelineJob" j
         JOIN "EditorialExportResult" r ON r."pipelineJobId"=j."id"
         JOIN "MediaArtifact" a ON a."id"=r."artifactId" AND a."pipelineJobId"=j."id"
        WHERE j."id"=$1 AND j."state"='READY' AND r."exportIntentId"=$2
          AND a."role"='EDITORIAL_EXPORT_PACKAGE' AND a."status"='READY'
          AND a."objectKey"=$3`,
      [job.id, job.editorialExportPlan.intentId, objectKey],
    );
    return accepted.rowCount === 1;
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
                "nextAttemptAt"=CASE WHEN $3='RETRY_WAIT' THEN now()+(LEAST(300,5*power(2,GREATEST(0,$7-1))) * interval '1 second') ELSE NULL END,
                "revision"="revision"+1, "updatedAt"=now()
          WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING'`,
        [
          job.id,
          job.leaseToken,
          state,
          code,
          message,
          retryScheduled,
          job.attemptNumber,
        ],
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

  private async claimAssembly(
    client: PoolClient,
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedMediaJob | null> {
    const selected = await client.query<AssemblyClaimRow>(
      `SELECT j."id", j."state", j."projectId", j."sourceId", j."sourceVersion",
              j."attemptCount", j."retryBudget", j."recipeVersion", j."queuedAt",
              j."startedAt" AS "jobStartedAt", i."id" AS "intentId",
              i."recipeRevisionId", i."recipeRevision", i."configurationFingerprint",
              i."renderContractVersion", i."audioProfileVersion", i."encodingProfileVersion",
              i."expectedDurationMs", r."advertisementInsertAtMs", r."ctaText",
              r."ctaStartMs", r."ctaEndMs", r."ctaPosition",
              a."id" AS "cutArtifactId", a."objectKey" AS "cutObjectKey",
              a."sizeBytes"::text AS "cutSizeBytes", a."sha256" AS "cutSha256",
              recipe."cutDurationMs"
         FROM "PipelineJob" j
         JOIN "AssemblyRenderIntent" i ON i."id"=j."assemblyRenderIntentId"
          AND i."projectId"=j."projectId" AND i."sourceId"=j."sourceId" AND i."sourceVersion"=j."sourceVersion"
         JOIN "AssemblyRecipe" recipe ON recipe."id"=i."assemblyRecipeId" AND recipe."pipelineJobId"=i."cutPipelineJobId"
         JOIN "AssemblyRecipeRevision" r ON r."id"=i."recipeRevisionId" AND r."recipeId"=i."assemblyRecipeId" AND r."revision"=i."recipeRevision"
         JOIN "MediaArtifact" a ON a."id"=i."cutResultArtifactId" AND a."pipelineJobId"=i."cutPipelineJobId"
          AND a."projectId"=i."projectId" AND a."lineageSourceId"=i."sourceId" AND a."lineageSourceVersion"=i."sourceVersion"
          AND a."role"='CUT_RESULT' AND a."status"='READY' AND a."sha256"=i."cutResultSha256"
          AND a."sizeBytes"=i."cutResultSizeBytes" AND a."recipeVersion"=i."cutResultRecipeVersion"
         JOIN "VideoSource" s ON s."id"=j."sourceId" AND s."projectId"=j."projectId"
          AND s."sourceVersion"=j."sourceVersion" AND s."status"='READY'
         JOIN "SourceAuthorization" auth ON auth."sourceId"=s."id" AND auth."sourceVersion"=s."sourceVersion"
          AND auth."status"='CLEARED' AND auth."basis" IS NOT NULL
          AND auth."declarationVersion" IS NOT NULL AND auth."decidedAt" IS NOT NULL
          AND (auth."basis" IN ('LEGACY_ATTESTATION','OPERATOR_ATTESTATION')
            OR (auth."basis"='LOCAL_DEVELOPMENT_AUTO' AND $2='local-auto'))
        WHERE j."id"=$1 AND j."type"='ASSEMBLE_HORIZONTAL' AND j."payloadVersion"=1
          AND j."recipeVersion"='horizontal-render-v1' AND i."renderContractVersion"='horizontal-render-v1'
          AND i."audioProfileVersion"='youtube-stereo-v1' AND i."encodingProfileVersion"='youtube-h264-v1'
          AND r."schemaVersion"='horizontal-assembly-v1' AND r."audioProfileVersion"=i."audioProfileVersion"
          AND r."encodingProfileVersion"=i."encodingProfileVersion"
          AND r."configurationFingerprint"=i."configurationFingerprint"
          AND j."totalMs"=i."expectedDurationMs"
          AND ((j."state"='QUEUED' AND (j."nextAttemptAt" IS NULL OR j."nextAttemptAt"<=now()))
            OR (j."state"='RETRY_WAIT' AND j."nextAttemptAt"<=now()))
        FOR UPDATE OF j`,
      [jobId, this.sourceAuthorizationPolicy],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query(
        `UPDATE "PipelineJob" SET "state"='FAILED_FINAL', "failureCode"='ASSEMBLY_INPUT_INVALID',
             "failureMessage"='Входы сборки или права больше не действительны.', "failureRetryable"=false,
             "finishedAt"=now(), "nextAttemptAt"=NULL, "revision"="revision"+1, "updatedAt"=now()
          WHERE "id"=$1 AND "type"='ASSEMBLE_HORIZONTAL'
            AND (("state"='QUEUED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=now()))
              OR ("state"='RETRY_WAIT' AND "nextAttemptAt"<=now()))`,
        [jobId],
      );
      return null;
    }
    const references = await client.query<{
      assetId: string;
      role: "INTRO" | "OUTRO" | "ADVERTISEMENT" | "BANNER";
      ordinal: number;
      objectKey: string;
      assetSizeBytes: string;
      assetSha256: string;
      assetDurationMs: number | null;
      hasAudio: boolean | null;
      startMs: number | null;
      endMs: number | null;
      position:
        "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT" | null;
    }>(
      `SELECT ref."assetId", ref."role", ref."ordinal", asset."objectKey",
              ref."assetSizeBytes"::text, ref."assetSha256", ref."assetDurationMs",
              asset."hasAudio", ref."startMs", ref."endMs", ref."position"
         FROM "AssemblyRecipeAssetReference" ref
         JOIN "MontageAsset" asset ON asset."id"=ref."assetId"
          AND asset."projectId"=$2 AND asset."sourceId"=$3 AND asset."sourceVersion"=$4
          AND asset."status"='READY' AND asset."revision"=ref."assetRevision"
          AND asset."sha256"=ref."assetSha256" AND asset."sizeBytes"=ref."assetSizeBytes"
          AND asset."kind"=ref."assetKind" AND asset."durationMs" IS NOT DISTINCT FROM ref."assetDurationMs"
          AND asset."rightsBasis"='LOCAL_DEVELOPMENT_AUTO'
          AND asset."rightsDeclaration"='montage-local-development-auto-v1'
          AND asset."rightsDecidedAt" IS NOT NULL AND $5='local-auto'
        WHERE ref."recipeRevisionId"=$1
        ORDER BY ref."role", ref."ordinal"`,
      [
        row.recipeRevisionId,
        row.projectId,
        row.sourceId,
        row.sourceVersion,
        this.sourceAuthorizationPolicy,
      ],
    );
    const expectedReferenceCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS "count" FROM "AssemblyRecipeAssetReference" WHERE "recipeRevisionId"=$1`,
      [row.recipeRevisionId],
    );
    const roleCount = (role: string) =>
      references.rows.filter((value) => value.role === role).length;
    const timingInvalid =
      roleCount("INTRO") > 1 ||
      roleCount("OUTRO") > 1 ||
      roleCount("ADVERTISEMENT") > 1 ||
      roleCount("BANNER") > 8 ||
      references.rows.some((value) =>
        value.role === "BANNER"
          ? value.assetDurationMs !== null ||
            value.startMs === null ||
            value.endMs === null ||
            value.position === null ||
            value.startMs < 0 ||
            value.endMs <= value.startMs ||
            value.endMs > row.cutDurationMs
          : value.assetDurationMs === null || value.assetDurationMs <= 0,
      ) ||
      (roleCount("ADVERTISEMENT") === 0
        ? row.advertisementInsertAtMs !== null
        : row.advertisementInsertAtMs === null ||
          row.advertisementInsertAtMs <= 0 ||
          row.advertisementInsertAtMs >= row.cutDurationMs) ||
      (row.ctaText === null
        ? row.ctaStartMs !== null ||
          row.ctaEndMs !== null ||
          row.ctaPosition !== null
        : !row.ctaText.trim() ||
          row.ctaText.length > 120 ||
          row.ctaStartMs === null ||
          row.ctaEndMs === null ||
          row.ctaPosition === null ||
          row.ctaStartMs < 0 ||
          row.ctaEndMs <= row.ctaStartMs ||
          row.ctaEndMs > row.cutDurationMs);
    if (
      Number(expectedReferenceCount.rows[0]?.count ?? -1) !==
        references.rows.length ||
      references.rows.length > 11 ||
      timingInvalid ||
      row.expectedDurationMs !==
        row.cutDurationMs +
          references.rows.reduce(
            (sum, value) =>
              value.role === "BANNER"
                ? sum
                : sum + (value.assetDurationMs ?? 0),
            0,
          )
    ) {
      await client.query(
        `UPDATE "PipelineJob" SET "state"='FAILED_FINAL', "failureCode"='ASSEMBLY_LINEAGE_INVALID',
             "failureMessage"='Снимок входов сборки не прошёл проверку.', "failureRetryable"=false,
             "finishedAt"=now(), "nextAttemptAt"=NULL, "revision"="revision"+1, "updatedAt"=now()
          WHERE "id"=$1 AND "state" IN ('QUEUED','RETRY_WAIT')`,
        [jobId],
      );
      return null;
    }
    const attemptNumber = row.attemptCount + 1;
    if (attemptNumber > row.retryBudget + 1) {
      await client.query(
        `UPDATE "PipelineJob" SET "state"='FAILED_FINAL', "failureCode"='RETRY_BUDGET_EXHAUSTED',
             "failureMessage"='Исчерпан лимит повторных попыток обработки.', "failureRetryable"=false,
             "finishedAt"=now(), "nextAttemptAt"=NULL, "revision"="revision"+1, "updatedAt"=now() WHERE "id"=$1`,
        [jobId],
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
              "heartbeatAt"=now(), "startedAt"=COALESCE("startedAt",now()), "nextAttemptAt"=NULL,
              "admissionReason"=NULL, "progressAttemptNumber"=NULL, "progressPhase"=NULL,
              "progressBasisPoints"=NULL, "progressUpdatedAt"=NULL,
              "failureCode"=NULL, "failureMessage"=NULL, "failureRetryable"=NULL,
              "revision"="revision"+1, "updatedAt"=now() WHERE "id"=$1`,
      [jobId, attemptNumber, workerId, leaseToken, leaseMs],
    );
    return {
      id: row.id,
      type: "ASSEMBLE_HORIZONTAL",
      projectId: row.projectId,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
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
      assemblyRenderPlan: {
        intentId: row.intentId,
        recipeRevisionId: row.recipeRevisionId,
        recipeRevision: row.recipeRevision,
        configurationFingerprint: row.configurationFingerprint,
        renderContractVersion: "horizontal-render-v1",
        audioProfileVersion: "youtube-stereo-v1",
        encodingProfileVersion: "youtube-h264-v1",
        expectedDurationMs: row.expectedDurationMs,
        advertisementInsertAtMs: row.advertisementInsertAtMs,
        cta:
          row.ctaText &&
          row.ctaStartMs !== null &&
          row.ctaEndMs !== null &&
          row.ctaPosition
            ? {
                text: row.ctaText,
                startMs: row.ctaStartMs,
                endMs: row.ctaEndMs,
                position: row.ctaPosition,
              }
            : null,
        inputs: [
          {
            id: row.cutArtifactId,
            role: "CUT",
            ordinal: 0,
            objectKey: row.cutObjectKey,
            sizeBytes: BigInt(row.cutSizeBytes),
            sha256: row.cutSha256,
            durationMs: row.cutDurationMs,
            hasAudio: null,
            startMs: null,
            endMs: null,
            position: null,
          },
          ...references.rows.map((value) => ({
            id: value.assetId,
            role: value.role,
            ordinal: value.ordinal,
            objectKey: value.objectKey,
            sizeBytes: BigInt(value.assetSizeBytes),
            sha256: value.assetSha256,
            durationMs: value.assetDurationMs,
            hasAudio: value.hasAudio,
            startMs: value.startMs,
            endMs: value.endMs,
            position: value.position,
          })),
        ],
      },
    };
  }

  private async claimExport(
    client: PoolClient,
    jobId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedMediaJob | null> {
    const selected = await client.query<ExportClaimRow>(
      `SELECT j."id", j."state", j."projectId", j."sourceId", j."sourceVersion",
              j."attemptCount", j."retryBudget", j."recipeVersion", j."queuedAt",
              j."startedAt" AS "jobStartedAt", e."id" AS "intentId",
              a."id" AS "approvalId", a."approvalContractVersion",
              e."exportContractVersion", a."candidateFingerprint",
              a."editorialPackageRevisionId", a."editorialRevision",
              a."processingTemplateRevisionId", a."recipeRevisionId", a."recipeRevision",
              a."configurationFingerprint", a."assemblyRenderResultId",
              a."renderContractVersion", video."id" AS "videoArtifactId",
              video."objectKey" AS "videoObjectKey", video."sizeBytes"::text AS "videoSizeBytes",
              video."sha256" AS "videoSha256", thumb."id" AS "thumbnailAssetId",
              thumb."objectKey" AS "thumbnailObjectKey", thumb."sizeBytes"::text AS "thumbnailSizeBytes",
              thumb."sha256" AS "thumbnailSha256", thumb."contentType" AS "thumbnailContentType",
              thumb."originalFilename" AS "thumbnailOriginalFilename", pr."title", pr."description", pr."tags"
         FROM "PipelineJob" j
         JOIN "EditorialExportIntent" e ON e."id"=j."editorialExportIntentId"
          AND e."projectId"=j."projectId" AND e."sourceId"=j."sourceId" AND e."sourceVersion"=j."sourceVersion"
         JOIN "EditorialApproval" a ON a."id"=e."approvalId" AND a."projectId"=e."projectId"
          AND a."sourceId"=e."sourceId" AND a."sourceVersion"=e."sourceVersion"
          AND a."cutPipelineJobId"=e."cutPipelineJobId"
          AND a."candidateFingerprint"=e."approvalCandidateFingerprint"
          AND a."editorialPackageRevisionId"=e."editorialPackageRevisionId"
          AND a."recipeRevisionId"=e."recipeRevisionId"
          AND a."assemblyRenderResultId"=e."assemblyRenderResultId"
         JOIN "VideoSource" s ON s."id"=a."sourceId" AND s."projectId"=a."projectId"
          AND s."sourceVersion"=a."sourceVersion" AND s."status"='READY'
         JOIN "SourceAuthorization" auth ON auth."sourceId"=s."id" AND auth."sourceVersion"=s."sourceVersion"
          AND auth."status"='CLEARED' AND auth."basis" IS NOT NULL
          AND auth."declarationVersion" IS NOT NULL AND auth."decidedAt" IS NOT NULL
          AND (auth."basis" IN ('LEGACY_ATTESTATION','OPERATOR_ATTESTATION')
            OR (auth."basis"='LOCAL_DEVELOPMENT_AUTO' AND $2='local-auto'))
         JOIN "EditorialPackage" p ON p."id"=a."editorialPackageId"
          AND p."currentRevision"=a."editorialRevision" AND p."projectId"=a."projectId"
          AND p."pipelineJobId"=a."cutPipelineJobId" AND p."lineageSourceId"=a."sourceId"
          AND p."lineageSourceVersion"=a."sourceVersion"
         JOIN "PipelineJob" cut_job ON cut_job."id"=a."cutPipelineJobId"
          AND cut_job."projectId"=a."projectId" AND cut_job."sourceId"=a."sourceId"
          AND cut_job."sourceVersion"=a."sourceVersion" AND cut_job."type"='CUT_SEGMENT'
          AND cut_job."state"='READY'
         JOIN "MediaArtifact" cut_artifact ON cut_artifact."id"=p."cutResultArtifactId"
          AND cut_artifact."pipelineJobId"=cut_job."id" AND cut_artifact."projectId"=a."projectId"
          AND cut_artifact."sourceId"=a."sourceId" AND cut_artifact."lineageSourceId"=a."sourceId"
          AND cut_artifact."lineageSourceVersion"=a."sourceVersion" AND cut_artifact."role"='CUT_RESULT'
          AND cut_artifact."status"='READY' AND cut_artifact."sha256"=p."cutResultSha256"
          AND cut_artifact."sizeBytes"=p."cutResultSizeBytes"
          AND cut_artifact."recipeVersion"=p."cutResultRecipeVersion"
         JOIN "EditorialPackageRevision" pr ON pr."id"=a."editorialPackageRevisionId"
          AND pr."packageId"=p."id" AND pr."revision"=a."editorialRevision"
          AND pr."processingTemplateRevisionId"=a."processingTemplateRevisionId"
          AND pr."thumbnailAssetId"=a."thumbnailAssetId"
          AND pr."title" IS NOT NULL AND length(btrim(pr."title"))>0
          AND pr."description" IS NOT NULL AND length(btrim(pr."description"))>0
          AND jsonb_typeof(pr."tags")='array' AND jsonb_array_length(pr."tags")>0
         JOIN "ProcessingTemplateRevision" ptr ON ptr."id"=pr."processingTemplateRevisionId"
          AND ptr."configurationVersion"='manual-editorial-v1'
         JOIN "EditorialAsset" thumb ON thumb."id"=a."thumbnailAssetId" AND thumb."projectId"=a."projectId"
          AND thumb."status"='READY' AND thumb."type"='THUMBNAIL'
          AND thumb."sha256"=a."thumbnailSha256" AND thumb."sizeBytes"=a."thumbnailSizeBytes"
          AND thumb."contentType"=a."thumbnailContentType"
          AND thumb."contentType" IN ('image/jpeg','image/png','image/webp')
         JOIN "AssemblyRecipe" recipe ON recipe."id"=a."assemblyRecipeId"
          AND recipe."currentRevision"=a."recipeRevision"
         JOIN "AssemblyRecipeRevision" rr ON rr."id"=a."recipeRevisionId"
          AND rr."recipeId"=recipe."id" AND rr."revision"=a."recipeRevision"
          AND rr."configurationFingerprint"=a."configurationFingerprint"
          AND rr."schemaVersion"='horizontal-assembly-v1'
          AND rr."audioProfileVersion"='youtube-stereo-v1'
          AND rr."encodingProfileVersion"='youtube-h264-v1'
         JOIN "AssemblyRenderIntent" ri ON ri."id"=a."assemblyRenderIntentId"
          AND ri."projectId"=a."projectId" AND ri."sourceId"=a."sourceId"
          AND ri."sourceVersion"=a."sourceVersion" AND ri."cutPipelineJobId"=a."cutPipelineJobId"
          AND ri."assemblyRecipeId"=a."assemblyRecipeId" AND ri."recipeRevisionId"=a."recipeRevisionId"
          AND ri."recipeRevision"=a."recipeRevision"
          AND ri."configurationFingerprint"=a."configurationFingerprint"
          AND ri."renderContractVersion"='horizontal-render-v1'
          AND ri."audioProfileVersion"=rr."audioProfileVersion"
          AND ri."encodingProfileVersion"=rr."encodingProfileVersion"
         JOIN "PipelineJob" render_job ON render_job."assemblyRenderIntentId"=ri."id"
          AND render_job."state"='READY' AND render_job."type"='ASSEMBLE_HORIZONTAL'
          AND render_job."projectId"=a."projectId" AND render_job."sourceId"=a."sourceId"
          AND render_job."sourceVersion"=a."sourceVersion"
          AND render_job."recipeVersion"='horizontal-render-v1'
         JOIN "AssemblyRenderResult" render_result ON render_result."id"=a."assemblyRenderResultId"
          AND render_result."renderIntentId"=ri."id" AND render_result."artifactId"=a."renderArtifactId"
         JOIN "MediaArtifact" video ON video."id"=render_result."artifactId"
          AND video."status"='READY' AND video."role"='HORIZONTAL_ASSEMBLY_RESULT'
          AND video."projectId"=a."projectId" AND video."sourceId"=a."sourceId"
          AND video."lineageSourceId"=a."sourceId"
          AND video."lineageSourceVersion"=a."sourceVersion" AND video."pipelineJobId"=render_job."id"
          AND video."sha256"=a."renderArtifactSha256" AND video."sizeBytes"=a."renderArtifactSizeBytes"
          AND video."contentType"='video/mp4' AND video."recipeVersion"='horizontal-render-v1'
        WHERE j."id"=$1 AND j."type"='EXPORT_EDITORIAL_PACKAGE' AND j."payloadVersion"=1
          AND j."recipeVersion"='editorial-export-zip-v1'
          AND e."exportContractVersion"='editorial-export-zip-v1'
          AND a."approvalContractVersion"='manual-horizontal-approval-v1'
          AND a."renderContractVersion"='horizontal-render-v1'
          AND NOT EXISTS (
            SELECT 1 FROM "AssemblyRecipeAssetReference" ref
            LEFT JOIN "MontageAsset" asset ON asset."id"=ref."assetId"
             AND asset."projectId"=a."projectId" AND asset."sourceId"=a."sourceId"
             AND asset."sourceVersion"=a."sourceVersion" AND asset."status"='READY'
             AND asset."revision"=ref."assetRevision" AND asset."sha256"=ref."assetSha256"
             AND asset."sizeBytes"=ref."assetSizeBytes" AND asset."kind"=ref."assetKind"
             AND asset."durationMs" IS NOT DISTINCT FROM ref."assetDurationMs"
             AND asset."rightsBasis"='LOCAL_DEVELOPMENT_AUTO'
             AND asset."rightsDeclaration"='montage-local-development-auto-v1'
             AND asset."rightsDecidedAt" IS NOT NULL AND $2='local-auto'
            WHERE ref."recipeRevisionId"=a."recipeRevisionId" AND asset."id" IS NULL
          )
          AND ((j."state"='QUEUED' AND (j."nextAttemptAt" IS NULL OR j."nextAttemptAt"<=now()))
            OR (j."state"='RETRY_WAIT' AND j."nextAttemptAt"<=now()))
        FOR UPDATE OF j`,
      [jobId, this.sourceAuthorizationPolicy],
    );
    const row = selected.rows[0];
    const tags = row ? stringArray(row.tags) : null;
    if (!row || !tags || tags.length === 0) {
      await client.query(
        `UPDATE "PipelineJob" SET "state"='FAILED_FINAL', "failureCode"='EXPORT_APPROVAL_STALE',
             "failureMessage"='The exact editorial approval is no longer current or authorized.',
             "failureRetryable"=false, "finishedAt"=now(), "nextAttemptAt"=NULL,
             "revision"="revision"+1, "updatedAt"=now()
          WHERE "id"=$1 AND "type"='EXPORT_EDITORIAL_PACKAGE'
            AND "state" IN ('QUEUED','RETRY_WAIT')`,
        [jobId],
      );
      return null;
    }
    const attemptNumber = row.attemptCount + 1;
    if (attemptNumber > row.retryBudget + 1) {
      await client.query(
        `UPDATE "PipelineJob" SET "state"='FAILED_FINAL', "failureCode"='RETRY_BUDGET_EXHAUSTED',
             "failureMessage"='Editorial export retry budget exhausted.', "failureRetryable"=false,
             "finishedAt"=now(), "nextAttemptAt"=NULL, "revision"="revision"+1, "updatedAt"=now()
          WHERE "id"=$1`,
        [jobId],
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
              "heartbeatAt"=now(), "startedAt"=COALESCE("startedAt",now()), "nextAttemptAt"=NULL,
              "admissionReason"=NULL, "progressAttemptNumber"=NULL, "progressPhase"=NULL,
              "progressBasisPoints"=NULL, "progressUpdatedAt"=NULL,
              "failureCode"=NULL, "failureMessage"=NULL, "failureRetryable"=NULL,
              "revision"="revision"+1, "updatedAt"=now() WHERE "id"=$1`,
      [jobId, attemptNumber, workerId, leaseToken, leaseMs],
    );
    return {
      id: row.id,
      type: "EXPORT_EDITORIAL_PACKAGE",
      projectId: row.projectId,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
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
      editorialExportPlan: {
        intentId: row.intentId,
        approvalId: row.approvalId,
        approvalContractVersion: "manual-horizontal-approval-v1",
        exportContractVersion: "editorial-export-zip-v1",
        candidateFingerprint: row.candidateFingerprint,
        editorialPackageRevisionId: row.editorialPackageRevisionId,
        editorialRevision: row.editorialRevision,
        processingTemplateRevisionId: row.processingTemplateRevisionId,
        recipeRevisionId: row.recipeRevisionId,
        recipeRevision: row.recipeRevision,
        configurationFingerprint: row.configurationFingerprint,
        assemblyRenderResultId: row.assemblyRenderResultId,
        renderContractVersion: "horizontal-render-v1",
        video: {
          artifactId: row.videoArtifactId,
          objectKey: row.videoObjectKey,
          sizeBytes: BigInt(row.videoSizeBytes),
          sha256: row.videoSha256,
        },
        thumbnail: {
          assetId: row.thumbnailAssetId,
          objectKey: row.thumbnailObjectKey,
          sizeBytes: BigInt(row.thumbnailSizeBytes),
          sha256: row.thumbnailSha256,
          contentType: row.thumbnailContentType,
          originalFilename: row.thumbnailOriginalFilename,
        },
        metadata: {
          title: row.title,
          description: row.description,
          tags,
        },
      },
    };
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

  private async assertExportCurrent(
    client: PoolClient,
    job: Extract<ClaimedMediaJob, { type: "EXPORT_EDITORIAL_PACKAGE" }>,
  ): Promise<void> {
    const current = await client.query(
      `SELECT 1
         FROM "EditorialExportIntent" e
         JOIN "EditorialApproval" a ON a."id"=e."approvalId" AND a."projectId"=e."projectId"
          AND a."sourceId"=e."sourceId" AND a."sourceVersion"=e."sourceVersion"
          AND a."cutPipelineJobId"=e."cutPipelineJobId"
          AND a."candidateFingerprint"=e."approvalCandidateFingerprint"
          AND a."editorialPackageRevisionId"=e."editorialPackageRevisionId"
          AND a."recipeRevisionId"=e."recipeRevisionId"
          AND a."assemblyRenderResultId"=e."assemblyRenderResultId"
         JOIN "EditorialPackage" p ON p."id"=a."editorialPackageId" AND p."currentRevision"=a."editorialRevision"
          AND p."projectId"=a."projectId" AND p."pipelineJobId"=a."cutPipelineJobId"
          AND p."lineageSourceId"=a."sourceId" AND p."lineageSourceVersion"=a."sourceVersion"
         JOIN "PipelineJob" cut_job ON cut_job."id"=a."cutPipelineJobId"
          AND cut_job."projectId"=a."projectId" AND cut_job."sourceId"=a."sourceId"
          AND cut_job."sourceVersion"=a."sourceVersion" AND cut_job."type"='CUT_SEGMENT'
          AND cut_job."state"='READY'
         JOIN "MediaArtifact" cut_artifact ON cut_artifact."id"=p."cutResultArtifactId"
          AND cut_artifact."pipelineJobId"=cut_job."id" AND cut_artifact."projectId"=a."projectId"
          AND cut_artifact."sourceId"=a."sourceId" AND cut_artifact."lineageSourceId"=a."sourceId"
          AND cut_artifact."lineageSourceVersion"=a."sourceVersion" AND cut_artifact."role"='CUT_RESULT'
          AND cut_artifact."status"='READY' AND cut_artifact."sha256"=p."cutResultSha256"
          AND cut_artifact."sizeBytes"=p."cutResultSizeBytes"
          AND cut_artifact."recipeVersion"=p."cutResultRecipeVersion"
         JOIN "EditorialPackageRevision" pr ON pr."id"=a."editorialPackageRevisionId"
          AND pr."packageId"=p."id" AND pr."revision"=a."editorialRevision"
          AND pr."processingTemplateRevisionId"=a."processingTemplateRevisionId"
          AND pr."thumbnailAssetId"=a."thumbnailAssetId"
          AND pr."title" IS NOT NULL AND length(btrim(pr."title"))>0
          AND pr."description" IS NOT NULL AND length(btrim(pr."description"))>0
          AND jsonb_typeof(pr."tags")='array' AND jsonb_array_length(pr."tags")>0
         JOIN "ProcessingTemplateRevision" ptr ON ptr."id"=pr."processingTemplateRevisionId"
          AND ptr."configurationVersion"='manual-editorial-v1'
         JOIN "EditorialAsset" thumb ON thumb."id"=a."thumbnailAssetId" AND thumb."projectId"=a."projectId"
          AND thumb."status"='READY' AND thumb."type"='THUMBNAIL'
          AND thumb."sha256"=a."thumbnailSha256"
          AND thumb."sizeBytes"=a."thumbnailSizeBytes" AND thumb."contentType"=a."thumbnailContentType"
          AND thumb."contentType" IN ('image/jpeg','image/png','image/webp')
         JOIN "AssemblyRecipe" recipe ON recipe."id"=a."assemblyRecipeId" AND recipe."currentRevision"=a."recipeRevision"
         JOIN "AssemblyRecipeRevision" rr ON rr."id"=a."recipeRevisionId"
          AND rr."recipeId"=recipe."id" AND rr."revision"=a."recipeRevision"
          AND rr."configurationFingerprint"=a."configurationFingerprint"
          AND rr."schemaVersion"='horizontal-assembly-v1'
          AND rr."audioProfileVersion"='youtube-stereo-v1'
          AND rr."encodingProfileVersion"='youtube-h264-v1'
         JOIN "AssemblyRenderIntent" ri ON ri."id"=a."assemblyRenderIntentId"
          AND ri."projectId"=a."projectId" AND ri."sourceId"=a."sourceId" AND ri."sourceVersion"=a."sourceVersion"
          AND ri."cutPipelineJobId"=a."cutPipelineJobId"
          AND ri."assemblyRecipeId"=a."assemblyRecipeId" AND ri."recipeRevisionId"=a."recipeRevisionId"
          AND ri."recipeRevision"=a."recipeRevision"
          AND ri."configurationFingerprint"=a."configurationFingerprint"
          AND ri."renderContractVersion"='horizontal-render-v1'
          AND ri."audioProfileVersion"=rr."audioProfileVersion"
          AND ri."encodingProfileVersion"=rr."encodingProfileVersion"
         JOIN "PipelineJob" render_job ON render_job."assemblyRenderIntentId"=ri."id"
          AND render_job."state"='READY' AND render_job."type"='ASSEMBLE_HORIZONTAL'
          AND render_job."projectId"=a."projectId" AND render_job."sourceId"=a."sourceId"
          AND render_job."sourceVersion"=a."sourceVersion"
          AND render_job."recipeVersion"='horizontal-render-v1'
         JOIN "AssemblyRenderResult" render_result ON render_result."id"=a."assemblyRenderResultId"
          AND render_result."renderIntentId"=ri."id" AND render_result."artifactId"=a."renderArtifactId"
         JOIN "MediaArtifact" video ON video."id"=render_result."artifactId" AND video."status"='READY'
          AND video."role"='HORIZONTAL_ASSEMBLY_RESULT' AND video."projectId"=a."projectId"
          AND video."sourceId"=a."sourceId" AND video."lineageSourceId"=a."sourceId"
          AND video."lineageSourceVersion"=a."sourceVersion"
          AND video."pipelineJobId"=render_job."id" AND video."contentType"='video/mp4'
          AND video."recipeVersion"='horizontal-render-v1'
          AND video."sha256"=a."renderArtifactSha256" AND video."sizeBytes"=a."renderArtifactSizeBytes"
         JOIN "VideoSource" s ON s."id"=a."sourceId" AND s."projectId"=a."projectId"
          AND s."sourceVersion"=a."sourceVersion" AND s."status"='READY'
         JOIN "SourceAuthorization" auth ON auth."sourceId"=s."id" AND auth."sourceVersion"=s."sourceVersion"
          AND auth."status"='CLEARED' AND auth."basis" IS NOT NULL
          AND auth."declarationVersion" IS NOT NULL AND auth."decidedAt" IS NOT NULL
          AND (auth."basis" IN ('LEGACY_ATTESTATION','OPERATOR_ATTESTATION')
            OR (auth."basis"='LOCAL_DEVELOPMENT_AUTO' AND $2='local-auto'))
        WHERE e."id"=$1 AND e."projectId"=$3 AND e."sourceId"=$4 AND e."sourceVersion"=$5
          AND e."approvalId"=$6 AND e."approvalCandidateFingerprint"=$7
          AND e."editorialPackageRevisionId"=$8 AND e."recipeRevisionId"=$9
          AND e."assemblyRenderResultId"=$10 AND e."exportContractVersion"='editorial-export-zip-v1'
          AND a."approvalContractVersion"='manual-horizontal-approval-v1'
          AND a."renderContractVersion"='horizontal-render-v1'
          AND NOT EXISTS (
            SELECT 1 FROM "AssemblyRecipeAssetReference" ref
            LEFT JOIN "MontageAsset" asset ON asset."id"=ref."assetId"
             AND asset."projectId"=a."projectId" AND asset."sourceId"=a."sourceId"
             AND asset."sourceVersion"=a."sourceVersion" AND asset."status"='READY'
             AND asset."revision"=ref."assetRevision" AND asset."sha256"=ref."assetSha256"
             AND asset."sizeBytes"=ref."assetSizeBytes" AND asset."kind"=ref."assetKind"
             AND asset."durationMs" IS NOT DISTINCT FROM ref."assetDurationMs"
             AND asset."rightsBasis"='LOCAL_DEVELOPMENT_AUTO'
             AND asset."rightsDeclaration"='montage-local-development-auto-v1'
             AND asset."rightsDecidedAt" IS NOT NULL AND $2='local-auto'
            WHERE ref."recipeRevisionId"=a."recipeRevisionId" AND asset."id" IS NULL
          )`,
      [
        job.editorialExportPlan.intentId,
        this.sourceAuthorizationPolicy,
        job.projectId,
        job.sourceId,
        job.sourceVersion,
        job.editorialExportPlan.approvalId,
        job.editorialExportPlan.candidateFingerprint,
        job.editorialExportPlan.editorialPackageRevisionId,
        job.editorialExportPlan.recipeRevisionId,
        job.editorialExportPlan.assemblyRenderResultId,
      ],
    );
    if (current.rowCount !== 1)
      throw new ControlledMediaError(
        "EXPORT_APPROVAL_STALE",
        "The exact editorial approval is no longer current or authorized.",
        false,
      );
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
