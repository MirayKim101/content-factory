import { Pool, type PoolClient } from "pg";

import type {
  PublicationClaim,
  PublicationAdapterResult,
  PublicationWorkerRepository,
} from "../application/publication.port.js";

type ClaimRow = {
  id: string;
  platform: "LOCAL_DRY_RUN" | "YOUTUBE" | "TIKTOK";
  contentKind: "EDITORIAL_EXPORT" | "VERTICAL_RESULT";
  contentId: string;
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
        `SELECT i."id", i."platform", i."contentKind",
                COALESCE(i."exportResultId", i."verticalResultId") AS "contentId",
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
        platform: row.platform,
        contentKind: row.contentKind,
        contentId: row.contentId,
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
      `UPDATE "PublicationIntent"
          SET "state" = 'FAILED_FINAL', "failureCode" = $2,
              "failureMessage" = $3, "finishedAt" = $4, "updatedAt" = $4
        WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $5`,
      [
        claim.id,
        code.slice(0, 120),
        message.slice(0, 1000),
        now,
        claim.attemptNumber,
      ],
    );
  }

  async markUnknownRemoteState(
    claim: PublicationClaim,
    code: string,
    message: string,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "PublicationIntent"
          SET "state" = 'UNKNOWN_REMOTE_STATE', "failureCode" = $2,
              "failureMessage" = $3, "updatedAt" = $4
        WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $5`,
      [
        claim.id,
        code.slice(0, 120),
        message.slice(0, 1000),
        now,
        claim.attemptNumber,
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
