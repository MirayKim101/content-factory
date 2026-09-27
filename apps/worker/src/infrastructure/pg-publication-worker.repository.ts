import { Pool, type PoolClient } from "pg";

import type {
  PublicationClaim,
  PublicationAdapterResult,
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
  contentSizeBytes: string;
  contentSha256: string;
  contentType: string;
  metadataSnapshot: Record<string, unknown>;
  attemptCount: number;
  retryBudget: number;
  state: string;
  startedAt: Date | null;
  lineageCurrent: boolean;
};

export class PgPublicationWorkerRepository implements PublicationWorkerRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
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
                COALESCE(ar."sizeBytes", vr."sizeBytes")::text AS "contentSizeBytes",
                COALESCE(ar."sha256", vr."sha256") AS "contentSha256",
                COALESCE(ar."contentType", vr."contentType") AS "contentType",
                i."metadataSnapshot",
                i."attemptCount", i."retryBudget", i."state", i."startedAt",
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const updated = await client.query<{ state: string }>(
        `UPDATE "PublicationIntent"
            SET "state" = CASE WHEN "attemptCount" <= "retryBudget"
                                THEN 'QUEUED'::"PublicationIntentState"
                                ELSE 'FAILED_FINAL'::"PublicationIntentState" END,
                "failureCode" = $2, "failureMessage" = $3,
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
    const result = await this.pool.query<{
      id: string;
      channelId: string;
      externalChannelRef: string;
      platform: PublicationClaim["platform"];
      contentKind: PublicationClaim["contentKind"];
      contentId: string;
      contentObjectKey: string;
      contentSizeBytes: string;
      contentSha256: string;
      contentType: string;
      metadataSnapshot: Record<string, unknown>;
      attemptCount: number;
      remotePublicationId: string;
    }>(
      `SELECT i."id", i."channelId", c."externalChannelRef",
              i."platform", i."contentKind",
              COALESCE(i."exportResultId", i."verticalResultId") AS "contentId",
              COALESCE(ar."objectKey", vr."objectKey") AS "contentObjectKey",
              COALESCE(ar."sizeBytes", vr."sizeBytes")::text AS "contentSizeBytes",
              COALESCE(ar."sha256", vr."sha256") AS "contentSha256",
              COALESCE(ar."contentType", vr."contentType") AS "contentType",
              i."metadataSnapshot", i."attemptCount", i."remotePublicationId"
         FROM "PublicationIntent" i
         JOIN "PublicationChannel" c ON c."id" = i."channelId"
         LEFT JOIN "EditorialExportResult" er ON er."id" = i."exportResultId"
         LEFT JOIN "MediaArtifact" ar ON ar."id" = er."artifactId"
         LEFT JOIN "VerticalRenderResult" var ON var."id" = i."verticalResultId"
         LEFT JOIN "MediaArtifact" vr ON vr."id" = var."artifactId"
        WHERE i."state" = 'UNKNOWN_REMOTE_STATE'
          AND i."remotePublicationId" IS NOT NULL
          AND i."updatedAt" <= $1::timestamp - interval '30 seconds'
        ORDER BY i."updatedAt" ASC, i."id" ASC LIMIT $2`,
      [now, Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return result.rows.map((row) => ({
      id: row.id,
      channelId: row.channelId,
      externalChannelRef: row.externalChannelRef,
      platform: row.platform,
      contentKind: row.contentKind,
      contentId: row.contentId,
      contentObjectKey: row.contentObjectKey,
      contentSizeBytes: BigInt(row.contentSizeBytes),
      contentSha256: row.contentSha256,
      contentType: row.contentType,
      metadataSnapshot: row.metadataSnapshot,
      attemptNumber: row.attemptCount,
      remotePublicationId: row.remotePublicationId,
    }));
  }

  async refreshUnknownRemoteState(
    claim: PublicationReconciliationClaim,
    remoteStatus: string,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "PublicationIntent" SET "remoteStatus" = $2, "updatedAt" = $3
        WHERE "id" = $1 AND "state" = 'UNKNOWN_REMOTE_STATE'
          AND "attemptCount" = $4 AND "remotePublicationId" = $5`,
      [
        claim.id,
        remoteStatus.slice(0, 120),
        now,
        claim.attemptNumber,
        claim.remotePublicationId,
      ],
    );
  }

  async finalizePublished(
    claim: PublicationReconciliationClaim,
    result: Extract<PublicationReconciliationResult, { state: "PUBLISHED" }>,
    now: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const updated = await client.query(
        `UPDATE "PublicationIntent"
            SET "state" = 'PUBLISHED', "remoteStatus" = $2,
                "failureCode" = NULL, "failureMessage" = NULL,
                "finishedAt" = $3, "updatedAt" = $3
          WHERE "id" = $1 AND "state" = 'UNKNOWN_REMOTE_STATE'
            AND "attemptCount" = $4 AND "remotePublicationId" = $5`,
        [
          claim.id,
          result.remoteStatus.slice(0, 120),
          now,
          claim.attemptNumber,
          claim.remotePublicationId,
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
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async failUnknownRemoteState(
    claim: PublicationReconciliationClaim,
    result: Extract<PublicationReconciliationResult, { state: "FAILED" }>,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `WITH finalized AS (
        UPDATE "PublicationIntent"
          SET "state" = 'FAILED_FINAL', "remoteStatus" = $2,
              "failureCode" = $3, "failureMessage" = $4,
              "finishedAt" = $5, "updatedAt" = $5
        WHERE "id" = $1 AND "state" = 'UNKNOWN_REMOTE_STATE'
          AND "attemptCount" = $6 AND "remotePublicationId" = $7
        RETURNING "id"
       )
       DELETE FROM "PublicationProviderSession" s
        USING finalized f WHERE s."publicationIntentId" = f."id"`,
      [
        claim.id,
        result.remoteStatus.slice(0, 120),
        result.code.slice(0, 120),
        result.message.slice(0, 1000),
        now,
        claim.attemptNumber,
        claim.remotePublicationId,
      ],
    );
  }

  async due(limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT "id" FROM "PublicationIntent"
        WHERE ("state" IN ('SCHEDULED', 'QUEUED') AND "scheduledAt" <= now())
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

function remoteId(receipt: Record<string, unknown>): string {
  const value = receipt.videoId ?? receipt.publishId ?? receipt.id;
  if (typeof value !== "string" || !value || value.length > 255)
    throw new Error("PUBLICATION_PROVIDER_RECEIPT_INVALID");
  return value;
}
