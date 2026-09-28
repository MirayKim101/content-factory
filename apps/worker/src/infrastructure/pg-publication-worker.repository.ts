import { Pool, type PoolClient } from "pg";
import { workerPgPoolConfig } from "./worker-pg-pool.js";

import type {
  PublicationClaim,
  PublicationAdapterResult,
  PublicationMetricsClaim,
  PublicationMetricsSnapshot,
  PublicationReconciliationClaim,
  PublicationReconciliationResult,
  PublicationWorkerRepository,
} from "../application/publication.port.js";

type ClaimRow = {
  id: string;
  channelId: string;
  externalChannelRef: string;
  platform: "LOCAL_DRY_RUN" | "YOUTUBE" | "TIKTOK";
  contentKind: "EDITORIAL_EXPORT" | "VERTICAL_RESULT";
  contentId: string;
  contentObjectKey: string;
  contentStorageVersion: string | null;
  contentSizeBytes: string;
  contentSha256: string;
  contentType: string;
  metadataSnapshot: Record<string, unknown>;
  attemptCount: number;
  retryBudget: number;
  state: string;
  startedAt: Date | null;
  lineageCurrent: boolean;
  providerSessionExists: boolean;
};

export class PgPublicationWorkerRepository implements PublicationWorkerRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, pool?: Pool) {
    this.pool = pool ?? new Pool(workerPgPoolConfig(databaseUrl, 2));
  }

  async claim(intentId: string, now: Date): Promise<PublicationClaim | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<ClaimRow>(
        `SELECT i."id", i."channelId", c."externalChannelRef",
                i."platform", i."contentKind",
                COALESCE(i."exportResultId", i."verticalResultId") AS "contentId",
                COALESCE(ar."objectKey", vr."objectKey") AS "contentObjectKey",
                COALESCE(ar."storageVersion", vr."storageVersion") AS "contentStorageVersion",
                COALESCE(ar."sizeBytes", vr."sizeBytes")::text AS "contentSizeBytes",
                COALESCE(ar."sha256", vr."sha256") AS "contentSha256",
                COALESCE(ar."contentType", vr."contentType") AS "contentType",
                i."metadataSnapshot",
                i."attemptCount", i."retryBudget", i."state", i."startedAt",
                EXISTS (SELECT 1 FROM "PublicationProviderSession" ps
                         WHERE ps."publicationIntentId" = i."id"
                           AND ps."platform" = i."platform") AS "providerSessionExists",
                CASE WHEN i."contentKind" = 'EDITORIAL_EXPORT' THEN (
                  c."state" = 'ENABLED'
                  AND c."platform" = i."platform"
                  AND e."projectId" = i."projectId"
                  AND e."approvalId" = i."approvalId"
                  AND a."projectId" = i."projectId"
                  AND s."sourceVersion" = a."sourceVersion"
                  AND p."currentRevision" = a."editorialRevision"
                  AND r."currentRevision" = a."recipeRevision"
                  AND j."state" = 'READY'
                  AND j."editorialExportIntentId" = e."id"
                  AND ar."status" = 'READY'
                  AND ar."role" = 'EDITORIAL_EXPORT_PACKAGE'
                  AND er."archiveSha256" = ar."sha256"
                  AND er."archiveSizeBytes" = ar."sizeBytes"
                ) WHEN i."contentKind" = 'VERTICAL_RESULT' THEN (
                  c."state" = 'ENABLED'
                  AND c."platform" = i."platform"
                  AND va."id" = i."verticalApprovalId"
                  AND va."resultId" = i."verticalResultId"
                  AND vi."projectId" = i."projectId"
                  AND vj."state" = 'READY'
                  AND vj."verticalRenderIntentId" = vi."id"
                  AND vr."pipelineJobId" = var."pipelineJobId"
                  AND vr."status" = 'READY'
                  AND vr."role" = 'VERTICAL_RENDER_RESULT'
                  AND vr."projectId" = i."projectId"
                  AND var."sha256" = vr."sha256"
                  AND var."sizeBytes" = vr."sizeBytes"
                ) ELSE false END AS "lineageCurrent"
           FROM "PublicationIntent" i
           JOIN "PublicationChannel" c ON c."id" = i."channelId"
           LEFT JOIN "EditorialExportResult" er ON er."id" = i."exportResultId"
           LEFT JOIN "EditorialExportIntent" e ON e."id" = er."exportIntentId"
           LEFT JOIN "EditorialApproval" a ON a."id" = i."approvalId"
           LEFT JOIN "VideoSource" s ON s."id" = a."sourceId"
           LEFT JOIN "EditorialPackage" p ON p."id" = a."editorialPackageId"
           LEFT JOIN "AssemblyRecipe" r ON r."id" = a."assemblyRecipeId"
           LEFT JOIN "PipelineJob" j ON j."id" = er."pipelineJobId"
           LEFT JOIN "MediaArtifact" ar ON ar."id" = er."artifactId"
           LEFT JOIN "VerticalRenderResult" var ON var."id" = i."verticalResultId"
           LEFT JOIN "VerticalApproval" va ON va."id" = i."verticalApprovalId"
           LEFT JOIN "VerticalRenderIntent" vi ON vi."id" = var."intentId"
           LEFT JOIN "PipelineJob" vj ON vj."id" = var."pipelineJobId"
           LEFT JOIN "MediaArtifact" vr ON vr."id" = var."artifactId"
          WHERE i."id" = $1 AND i."scheduledAt" <= $2
            AND (i."nextAttemptAt" IS NULL OR i."nextAttemptAt" <= $2)
          FOR UPDATE OF i`,
        [intentId, now],
      );
      const row = result.rows[0];
      if (
        !row ||
        ["DRY_RUN_READY", "PUBLISHED", "FAILED_FINAL", "CANCELED"].includes(
          row.state,
        )
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      const staleProcessing =
        row.state === "PROCESSING" &&
        row.startedAt !== null &&
        row.startedAt.getTime() <= now.getTime() - 300_000;
      if (
        staleProcessing &&
        row.platform !== "LOCAL_DRY_RUN" &&
        !row.providerSessionExists
      ) {
        await client.query(
          `UPDATE "PublicationIntent"
              SET "state" = 'UNKNOWN_REMOTE_STATE',
                  "failureCode" = 'PUBLICATION_STALE_PROCESSING_OUTCOME_UNKNOWN',
                  "failureMessage" = 'The external attempt lost its durable worker before a resumable provider session was recorded.',
                  "remoteStatus" = 'stale_processing_without_session',
                  "updatedAt" = $2
            WHERE "id" = $1 AND "state" = 'PROCESSING'
              AND "attemptCount" = $3`,
          [row.id, now, row.attemptCount],
        );
        await client.query("COMMIT");
        return null;
      }
      if (!["SCHEDULED", "QUEUED"].includes(row.state) && !staleProcessing) {
        await client.query("ROLLBACK");
        return null;
      }
      if (!row.lineageCurrent || row.attemptCount > row.retryBudget) {
        await this.failLocked(
          client,
          row.id,
          "PUBLICATION_LINEAGE_STALE",
          "Publication lineage or channel is no longer current.",
          now,
        );
        await client.query("COMMIT");
        return null;
      }
      const attemptNumber = row.attemptCount + 1;
      await client.query(
        `UPDATE "PublicationIntent"
            SET "state" = 'PROCESSING', "attemptCount" = $2,
                "startedAt" = $3, "queuedAt" = COALESCE("queuedAt", $3),
                "nextAttemptAt" = NULL,
                "failureCode" = NULL, "failureMessage" = NULL,
                "updatedAt" = $3
          WHERE "id" = $1`,
        [row.id, attemptNumber, now],
      );
      await client.query("COMMIT");
      return {
        id: row.id,
        channelId: row.channelId,
        externalChannelRef: row.externalChannelRef,
        platform: row.platform,
        contentKind: row.contentKind,
        contentId: row.contentId,
        contentObjectKey: row.contentObjectKey,
        contentStorageVersion: row.contentStorageVersion,
        contentSizeBytes: BigInt(row.contentSizeBytes),
        contentSha256: row.contentSha256,
        contentType: row.contentType,
        metadataSnapshot: row.metadataSnapshot,
        attemptNumber,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(claim: PublicationClaim, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "PublicationIntent" SET "startedAt" = $3, "updatedAt" = $3
        WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $2`,
      [claim.id, claim.attemptNumber, now],
    );
    return result.rowCount === 1;
  }

  async releaseClaim(claim: PublicationClaim, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "PublicationIntent"
          SET "state" = 'QUEUED',
              "attemptCount" = GREATEST("attemptCount" - 1, 0),
              "startedAt" = NULL, "nextAttemptAt" = NULL,
              "failureCode" = NULL, "failureMessage" = NULL,
              "updatedAt" = $3
        WHERE "id" = $1 AND "state" = 'PROCESSING'
          AND "attemptCount" = $2`,
      [claim.id, claim.attemptNumber, now],
    );
    return result.rowCount === 1;
  }

  async finalizeDryRun(
    claim: PublicationClaim,
    result: PublicationAdapterResult,
    now: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const locked = await client.query<{
        state: string;
        attemptCount: number;
      }>(
        `SELECT "state", "attemptCount" FROM "PublicationIntent"
          WHERE "id" = $1 FOR UPDATE`,
        [claim.id],
      );
      const row = locked.rows[0];
      if (
        !row ||
        row.state !== "PROCESSING" ||
        row.attemptCount !== claim.attemptNumber
      ) {
        await client.query("ROLLBACK");
        return;
      }
      await client.query(
        `INSERT INTO "PublicationResult"
          ("id", "publicationIntentId", "resultContractVersion", "adapterVersion",
           "providerReceipt", "publicUrl", "completedAt", "createdAt")
         VALUES (gen_random_uuid(), $1, 'publication-result-v1', $2, $3::jsonb, $4, $5, $5)
         ON CONFLICT ("publicationIntentId") DO NOTHING`,
        [
          claim.id,
          result.adapterVersion,
          JSON.stringify(result.providerReceipt),
          result.publicUrl,
          now,
        ],
      );
      await client.query(
        `UPDATE "PublicationIntent"
            SET "state" = 'DRY_RUN_READY', "finishedAt" = $2, "updatedAt" = $2
          WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $3`,
        [claim.id, now, claim.attemptNumber],
      );
      await client.query(
        `DELETE FROM "PublicationProviderSession" WHERE "publicationIntentId" = $1`,
        [claim.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async failFinal(
    claim: PublicationClaim,
    code: string,
    message: string,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `WITH finalized AS (
        UPDATE "PublicationIntent"
          SET "state" = 'FAILED_FINAL', "failureCode" = $2,
              "failureMessage" = $3, "finishedAt" = $4, "updatedAt" = $4
        WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $5
        RETURNING "id"
       )
       DELETE FROM "PublicationProviderSession" s
        USING finalized f WHERE s."publicationIntentId" = f."id"`,
      [
        claim.id,
        code.slice(0, 120),
        message.slice(0, 1000),
        now,
        claim.attemptNumber,
      ],
    );
  }

  async finalizePublishedDirect(
    claim: PublicationClaim,
    result: PublicationAdapterResult,
    now: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const updated = await client.query(
        `UPDATE "PublicationIntent"
            SET "state" = 'PUBLISHED', "remotePublicationId" = $2,
                "remoteStatus" = 'published', "failureCode" = NULL,
                "failureMessage" = NULL, "finishedAt" = $3, "updatedAt" = $3
          WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $4
            AND "platform" <> 'LOCAL_DRY_RUN'`,
        [claim.id, remoteId(result.providerReceipt), now, claim.attemptNumber],
      );
      if (updated.rowCount === 1) {
        await client.query(
          `INSERT INTO "PublicationResult"
            ("id", "publicationIntentId", "resultContractVersion", "adapterVersion",
             "providerReceipt", "publicUrl", "completedAt", "createdAt")
           VALUES (gen_random_uuid(), $1, 'publication-result-v1', $2, $3::jsonb, $4, $5, $5)
           ON CONFLICT ("publicationIntentId") DO NOTHING`,
          [
            claim.id,
            result.adapterVersion,
            JSON.stringify(result.providerReceipt),
            result.publicUrl,
            now,
          ],
        );
        await client.query(
          `DELETE FROM "PublicationProviderSession" WHERE "publicationIntentId" = $1`,
          [claim.id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseForRetry(
    claim: PublicationClaim,
    code: string,
    message: string,
    now: Date,
  ): Promise<void> {
    const nextAttemptAt = publicationRetryAt(now, claim.attemptNumber);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const updated = await client.query<{ state: string }>(
        `UPDATE "PublicationIntent"
            SET "state" = CASE WHEN "attemptCount" <= "retryBudget"
                                THEN 'QUEUED'::"PublicationIntentState"
                                ELSE 'FAILED_FINAL'::"PublicationIntentState" END,
                "failureCode" = $2, "failureMessage" = $3,
                "nextAttemptAt" = CASE WHEN "attemptCount" <= "retryBudget"
                                       THEN $6 ELSE NULL END,
                "finishedAt" = CASE WHEN "attemptCount" > "retryBudget" THEN $4 ELSE NULL END,
                "updatedAt" = $4
          WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $5
          RETURNING "state"`,
        [
          claim.id,
          code.slice(0, 120),
          message.slice(0, 1000),
          now,
          claim.attemptNumber,
          nextAttemptAt,
        ],
      );
      if (updated.rows[0]?.state === "FAILED_FINAL")
        await client.query(
          `DELETE FROM "PublicationProviderSession" WHERE "publicationIntentId" = $1`,
          [claim.id],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markUnknownRemoteState(
    claim: PublicationClaim,
    code: string,
    message: string,
    remotePublicationId: string | null,
    remoteStatus: string | null,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "PublicationIntent"
          SET "state" = 'UNKNOWN_REMOTE_STATE', "failureCode" = $2,
              "failureMessage" = $3, "remotePublicationId" = $4,
              "remoteStatus" = $5, "updatedAt" = $6
        WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $7`,
      [
        claim.id,
        code.slice(0, 120),
        message.slice(0, 1000),
        remotePublicationId?.slice(0, 255) ?? null,
        remoteStatus?.slice(0, 120) ?? null,
        now,
        claim.attemptNumber,
      ],
    );
  }

  async unknownRemoteOutcomes(
    now: Date,
    limit = 100,
  ): Promise<PublicationReconciliationClaim[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const selected = await client.query<{ id: string }>(
        `SELECT "id" FROM "PublicationIntent"
          WHERE "state" = 'UNKNOWN_REMOTE_STATE'
            AND "remotePublicationId" IS NOT NULL
            AND "updatedAt" <= $1::timestamp - interval '30 seconds'
            AND ("reconciliationLeaseExpiresAt" IS NULL OR "reconciliationLeaseExpiresAt" <= $1)
          ORDER BY "updatedAt" ASC, "id" ASC
          LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, boundedLimit],
      );
      if (selected.rows.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const ids = selected.rows.map((row) => row.id);
      await client.query(
        `UPDATE "PublicationIntent"
            SET "reconciliationLeaseToken" = gen_random_uuid()::text,
                "reconciliationLeaseExpiresAt" = $2::timestamp + interval '2 minutes'
          WHERE "id" = ANY($1::uuid[])`,
        [ids, now],
      );
      const result = await client.query<{
        id: string;
        channelId: string;
        externalChannelRef: string;
        platform: PublicationClaim["platform"];
        contentKind: PublicationClaim["contentKind"];
        contentId: string;
        contentObjectKey: string;
        contentStorageVersion: string | null;
        contentSizeBytes: string;
        contentSha256: string;
        contentType: string;
        metadataSnapshot: Record<string, unknown>;
        attemptCount: number;
        remotePublicationId: string;
        reconciliationLeaseToken: string;
      }>(
        `SELECT i."id", i."channelId", c."externalChannelRef",
              i."platform", i."contentKind",
              COALESCE(i."exportResultId", i."verticalResultId") AS "contentId",
              COALESCE(ar."objectKey", vr."objectKey") AS "contentObjectKey",
              COALESCE(ar."storageVersion", vr."storageVersion") AS "contentStorageVersion",
              COALESCE(ar."sizeBytes", vr."sizeBytes")::text AS "contentSizeBytes",
              COALESCE(ar."sha256", vr."sha256") AS "contentSha256",
              COALESCE(ar."contentType", vr."contentType") AS "contentType",
              i."metadataSnapshot", i."attemptCount", i."remotePublicationId",
              i."reconciliationLeaseToken"
         FROM "PublicationIntent" i
         JOIN "PublicationChannel" c ON c."id" = i."channelId"
         LEFT JOIN "EditorialExportResult" er ON er."id" = i."exportResultId"
         LEFT JOIN "MediaArtifact" ar ON ar."id" = er."artifactId"
         LEFT JOIN "VerticalRenderResult" var ON var."id" = i."verticalResultId"
         LEFT JOIN "MediaArtifact" vr ON vr."id" = var."artifactId"
        WHERE i."id" = ANY($1::uuid[])
        ORDER BY i."updatedAt" ASC, i."id" ASC`,
        [ids],
      );
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        id: row.id,
        channelId: row.channelId,
        externalChannelRef: row.externalChannelRef,
        platform: row.platform,
        contentKind: row.contentKind,
        contentId: row.contentId,
        contentObjectKey: row.contentObjectKey,
        contentStorageVersion: row.contentStorageVersion,
        contentSizeBytes: BigInt(row.contentSizeBytes),
        contentSha256: row.contentSha256,
        contentType: row.contentType,
        metadataSnapshot: row.metadataSnapshot,
        attemptNumber: row.attemptCount,
        remotePublicationId: row.remotePublicationId,
        reconciliationLeaseToken: row.reconciliationLeaseToken,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshUnknownRemoteState(
    claim: PublicationReconciliationClaim,
    remoteStatus: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "PublicationIntent" SET "remoteStatus" = $2, "updatedAt" = $3,
              "reconciliationLeaseToken" = NULL, "reconciliationLeaseExpiresAt" = NULL
        WHERE "id" = $1 AND "state" = 'UNKNOWN_REMOTE_STATE'
          AND "attemptCount" = $4 AND "remotePublicationId" = $5
          AND "reconciliationLeaseToken" = $6
          AND "reconciliationLeaseExpiresAt" > $3`,
      [
        claim.id,
        remoteStatus.slice(0, 120),
        now,
        claim.attemptNumber,
        claim.remotePublicationId,
        claim.reconciliationLeaseToken,
      ],
    );
    return result.rowCount === 1;
  }

  async heartbeatReconciliationClaim(
    claim: PublicationReconciliationClaim,
    now: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "PublicationIntent"
          SET "reconciliationLeaseExpiresAt" = $3::timestamp + interval '2 minutes'
        WHERE "id" = $1 AND "state" = 'UNKNOWN_REMOTE_STATE'
          AND "reconciliationLeaseToken" = $2
          AND "reconciliationLeaseExpiresAt" > $3`,
      [claim.id, claim.reconciliationLeaseToken, now],
    );
    return result.rowCount === 1;
  }

  async finalizePublished(
    claim: PublicationReconciliationClaim,
    result: Extract<PublicationReconciliationResult, { state: "PUBLISHED" }>,
    now: Date,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const updated = await client.query(
        `UPDATE "PublicationIntent"
            SET "state" = 'PUBLISHED', "remoteStatus" = $2,
                "failureCode" = NULL, "failureMessage" = NULL,
                "finishedAt" = $3, "updatedAt" = $3,
                "reconciliationLeaseToken" = NULL, "reconciliationLeaseExpiresAt" = NULL
          WHERE "id" = $1 AND "state" = 'UNKNOWN_REMOTE_STATE'
            AND "attemptCount" = $4 AND "remotePublicationId" = $5
            AND "reconciliationLeaseToken" = $6
            AND "reconciliationLeaseExpiresAt" > $3`,
        [
          claim.id,
          result.remoteStatus.slice(0, 120),
          now,
          claim.attemptNumber,
          claim.remotePublicationId,
          claim.reconciliationLeaseToken,
        ],
      );
      if (updated.rowCount === 1)
        await client.query(
          `INSERT INTO "PublicationResult"
            ("id", "publicationIntentId", "resultContractVersion", "adapterVersion",
             "providerReceipt", "publicUrl", "completedAt", "createdAt")
           VALUES (gen_random_uuid(), $1, 'publication-result-v1', $2, $3::jsonb, $4, $5, $5)
           ON CONFLICT ("publicationIntentId") DO NOTHING`,
          [
            claim.id,
            result.adapterVersion,
            JSON.stringify(result.providerReceipt),
            result.publicUrl,
            now,
          ],
        );
      if (updated.rowCount === 1)
        await client.query(
          `DELETE FROM "PublicationProviderSession" WHERE "publicationIntentId" = $1`,
          [claim.id],
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

  async failUnknownRemoteState(
    claim: PublicationReconciliationClaim,
    outcome: Extract<PublicationReconciliationResult, { state: "FAILED" }>,
    now: Date,
  ): Promise<boolean> {
    const query = await this.pool.query<{ applied: boolean }>(
      `WITH finalized AS (
        UPDATE "PublicationIntent"
          SET "state" = 'FAILED_FINAL', "remoteStatus" = $2,
              "failureCode" = $3, "failureMessage" = $4,
              "finishedAt" = $5, "updatedAt" = $5,
              "reconciliationLeaseToken" = NULL, "reconciliationLeaseExpiresAt" = NULL
        WHERE "id" = $1 AND "state" = 'UNKNOWN_REMOTE_STATE'
          AND "attemptCount" = $6 AND "remotePublicationId" = $7
          AND "reconciliationLeaseToken" = $8
          AND "reconciliationLeaseExpiresAt" > $5
        RETURNING "id"
       ), deleted AS (
         DELETE FROM "PublicationProviderSession" s
          USING finalized f WHERE s."publicationIntentId" = f."id"
          RETURNING s."publicationIntentId"
       )
       SELECT EXISTS(SELECT 1 FROM finalized) AS "applied"`,
      [
        claim.id,
        outcome.remoteStatus.slice(0, 120),
        outcome.code.slice(0, 120),
        outcome.message.slice(0, 1000),
        now,
        claim.attemptNumber,
        claim.remotePublicationId,
        claim.reconciliationLeaseToken,
      ],
    );
    return query.rows[0]?.applied === true;
  }

  async releaseReconciliationClaim(
    claim: PublicationReconciliationClaim,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "PublicationIntent"
          SET "reconciliationLeaseToken" = NULL, "reconciliationLeaseExpiresAt" = NULL
        WHERE "id" = $1 AND "state" = 'UNKNOWN_REMOTE_STATE'
          AND "reconciliationLeaseToken" = $2`,
      [claim.id, claim.reconciliationLeaseToken],
    );
  }

  async claimPublishedForMetrics(
    now: Date,
    limit = 50,
  ): Promise<PublicationMetricsClaim[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
      const selected = await client.query<{ id: string }>(
        `SELECT i."id" FROM "PublicationIntent" i
          JOIN "PublicationResult" r ON r."publicationIntentId" = i."id"
          LEFT JOIN LATERAL (
            SELECT m."observedAt" FROM "PublicationMetricSnapshot" m
             WHERE m."publicationIntentId" = i."id"
             ORDER BY m."observedAt" DESC LIMIT 1
          ) latest ON TRUE
         WHERE i."state" = 'PUBLISHED'
           AND i."platform" IN ('YOUTUBE', 'TIKTOK')
           AND i."remotePublicationId" IS NOT NULL
           AND (i."platform" = 'YOUTUBE' OR r."providerReceipt"->'postIds'->>0 IS NOT NULL)
           AND (latest."observedAt" IS NULL OR latest."observedAt" <= $1::timestamp - interval '15 minutes')
           AND (i."metricsLeaseExpiresAt" IS NULL OR i."metricsLeaseExpiresAt" <= $1)
         ORDER BY latest."observedAt" ASC NULLS FIRST, i."id" ASC
         LIMIT $2 FOR UPDATE OF i SKIP LOCKED`,
        [now, boundedLimit],
      );
      if (!selected.rows.length) {
        await client.query("COMMIT");
        return [];
      }
      const ids = selected.rows.map((row) => row.id);
      const claimed = await client.query<{
        id: string;
        channelId: string;
        externalChannelRef: string;
        platform: "YOUTUBE" | "TIKTOK";
        remotePublicationId: string;
        metricsLeaseToken: string;
      }>(
        `UPDATE "PublicationIntent" i
            SET "metricsLeaseToken" = gen_random_uuid()::text,
                "metricsLeaseExpiresAt" = $2::timestamp + interval '2 minutes'
           FROM "PublicationChannel" c, "PublicationResult" r
          WHERE i."id" = ANY($1::uuid[]) AND c."id" = i."channelId"
            AND r."publicationIntentId" = i."id"
        RETURNING i."id", i."channelId", c."externalChannelRef", i."platform",
                  CASE WHEN i."platform" = 'TIKTOK'
                    THEN r."providerReceipt"->'postIds'->>0
                    ELSE i."remotePublicationId"
                  END AS "remotePublicationId",
                  i."metricsLeaseToken"`,
        [ids, now],
      );
      await client.query("COMMIT");
      return claimed.rows;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordMetrics(
    claim: PublicationMetricsClaim,
    snapshot: PublicationMetricsSnapshot,
    observedAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query<{ applied: boolean }>(
      `WITH owned AS (
         UPDATE "PublicationIntent"
            SET "metricsLeaseToken" = NULL, "metricsLeaseExpiresAt" = NULL
          WHERE "id" = $1 AND "state" = 'PUBLISHED'
            AND "platform" = $2 AND "metricsLeaseToken" = $3
            AND "metricsLeaseExpiresAt" > $9
        RETURNING "id", "platform"
       ), inserted AS (
         INSERT INTO "PublicationMetricSnapshot"
           ("id", "publicationIntentId", "platform", "viewCount", "likeCount",
            "commentCount", "shareCount", "adapterVersion", "observedAt")
         SELECT gen_random_uuid(), "id", "platform", $4, $5, $6, $7, $8, $9
           FROM owned
         ON CONFLICT ("publicationIntentId", "observedAt") DO NOTHING
         RETURNING "id"
       )
       SELECT EXISTS(SELECT 1 FROM inserted) AS "applied"`,
      [
        claim.id,
        claim.platform,
        claim.metricsLeaseToken,
        snapshot.viewCount.toString(),
        snapshot.likeCount?.toString() ?? null,
        snapshot.commentCount?.toString() ?? null,
        snapshot.shareCount?.toString() ?? null,
        snapshot.adapterVersion,
        observedAt,
      ],
    );
    return result.rows[0]?.applied === true;
  }

  async heartbeatMetricsClaim(
    claim: PublicationMetricsClaim,
    now: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "PublicationIntent"
          SET "metricsLeaseExpiresAt" = $3::timestamp + interval '2 minutes'
        WHERE "id" = $1 AND "state" = 'PUBLISHED'
          AND "metricsLeaseToken" = $2
          AND "metricsLeaseExpiresAt" > $3`,
      [claim.id, claim.metricsLeaseToken, now],
    );
    return result.rowCount === 1;
  }

  async releaseMetricsClaim(claim: PublicationMetricsClaim): Promise<void> {
    await this.pool.query(
      `UPDATE "PublicationIntent"
          SET "metricsLeaseToken" = NULL, "metricsLeaseExpiresAt" = NULL
        WHERE "id" = $1 AND "state" = 'PUBLISHED'
          AND "metricsLeaseToken" = $2`,
      [claim.id, claim.metricsLeaseToken],
    );
  }

  async due(limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT "id" FROM "PublicationIntent"
        WHERE ("state" IN ('SCHEDULED', 'QUEUED') AND "scheduledAt" <= now()
               AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now()))
           OR ("state" = 'PROCESSING' AND "startedAt" <= now() - interval '5 minutes')
        ORDER BY "scheduledAt" ASC, "id" ASC LIMIT $1`,
      [Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return result.rows.map((row) => row.id);
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  private failLocked(
    client: PoolClient,
    id: string,
    code: string,
    message: string,
    now: Date,
  ) {
    return client.query(
      `UPDATE "PublicationIntent"
          SET "state" = 'FAILED_FINAL', "failureCode" = $2,
              "failureMessage" = $3, "finishedAt" = $4, "updatedAt" = $4
        WHERE "id" = $1`,
      [id, code, message, now],
    );
  }
}

export function publicationRetryAt(now: Date, attemptNumber: number): Date {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1)
    throw new Error("PUBLICATION_ATTEMPT_NUMBER_INVALID");
  const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** (attemptNumber - 1));
  return new Date(now.getTime() + delayMs);
}

function remoteId(receipt: Record<string, unknown>): string {
  const value = receipt.videoId ?? receipt.publishId ?? receipt.id;
  if (typeof value !== "string" || !value || value.length > 255)
    throw new Error("PUBLICATION_PROVIDER_RECEIPT_INVALID");
  return value;
}
