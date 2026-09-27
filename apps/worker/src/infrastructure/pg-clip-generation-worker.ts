import { randomUUID } from "node:crypto";

import {
  validateClipGenerationRequest,
  type ClipGenerationRequest,
} from "@content-factory/contracts";
import { Pool, type PoolClient } from "pg";

import type { ClipGenerationProvider } from "../application/clip-generation-provider.port.js";

type Claim = Readonly<{
  intentId: string;
  leaseToken: string;
  request: ClipGenerationRequest;
}>;

export class PgClipGenerationWorker {
  private readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly provider: ClipGenerationProvider,
    private readonly leaseMs = 150_000,
  ) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  async process(intentId: string): Promise<void> {
    const claim = await this.claim(intentId);
    if (!claim) return;
    try {
      const result = await this.provider.generate(claim.request);
      await this.finalize(claim, result);
    } catch (error) {
      await this.fail(
        claim,
        error instanceof Error ? error.message : "CLIP_GENERATION_FAILED",
      );
      throw error;
    }
  }

  async recover(limit = 20): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT "id" FROM "ClipGenerationIntent"
        WHERE "state" = 'QUEUED'
           OR ("state" = 'PROCESSING' AND "leaseExpiresAt" <= now())
        ORDER BY "createdAt", "id" LIMIT $1`,
      [Math.max(1, Math.min(100, Math.trunc(limit)))],
    );
    for (const row of result.rows)
      await this.process(row.id).catch(() => undefined);
    return result.rows.length;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async claim(intentId: string): Promise<Claim | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<{
        id: string;
        state: string;
        leaseExpiresAt: Date | null;
        attemptCount: number;
        sourceTitle: string;
        sourceDurationMs: number;
        transcript: unknown;
        language: string;
        maximumSuggestions: number;
        minimumClipDurationMs: number;
        maximumClipDurationMs: number;
      }>(
        `SELECT i.* FROM "ClipGenerationIntent" i
          WHERE i."id" = $1 FOR UPDATE`,
        [intentId],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.state === "READY" ||
        row.state === "FAILED_FINAL" ||
        (row.state === "PROCESSING" &&
          row.leaseExpiresAt &&
          row.leaseExpiresAt > new Date())
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (row.attemptCount >= 2) {
        await client.query(
          `UPDATE "ClipGenerationIntent" SET "state" = 'FAILED_FINAL',
             "failureCode" = 'CLIP_GENERATION_RETRY_EXHAUSTED',
             "failureMessage" = 'Исчерпан лимит попыток генерации клипов.',
             "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
           WHERE "id" = $1`,
          [intentId],
        );
        await client.query("COMMIT");
        return null;
      }
      if (!(await sourceIsCurrentAndCleared(client, intentId))) {
        await client.query(
          `UPDATE "ClipGenerationIntent" SET "state" = 'FAILED_FINAL',
             "failureCode" = 'CLIP_GENERATION_SOURCE_STALE',
             "failureMessage" = 'Исходник или подтверждение прав изменились.',
             "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
           WHERE "id" = $1`,
          [intentId],
        );
        await client.query("COMMIT");
        return null;
      }
      const request: ClipGenerationRequest = {
        sourceTitle: row.sourceTitle,
        sourceDurationMs: row.sourceDurationMs,
        transcript: row.transcript as ClipGenerationRequest["transcript"],
        language: row.language,
        maximumSuggestions: row.maximumSuggestions,
        minimumClipDurationMs: row.minimumClipDurationMs,
        maximumClipDurationMs: row.maximumClipDurationMs,
      };
      validateClipGenerationRequest(request);
      const leaseToken = randomUUID();
      await client.query(
        `UPDATE "ClipGenerationIntent" SET "state" = 'PROCESSING',
           "leaseToken" = $2, "leaseExpiresAt" = now() + $3 * interval '1 millisecond',
           "attemptCount" = "attemptCount" + 1, "failureCode" = NULL,
           "failureMessage" = NULL, "updatedAt" = now() WHERE "id" = $1`,
        [intentId, leaseToken, this.leaseMs],
      );
      await client.query("COMMIT");
      return { intentId, leaseToken, request };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async finalize(
    claim: Claim,
    result: Awaited<ReturnType<ClipGenerationProvider["generate"]>>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const fenced = await client.query(
        `SELECT "id" FROM "ClipGenerationIntent" WHERE "id" = $1
          AND "state" = 'PROCESSING' AND "leaseToken" = $2
          AND "leaseExpiresAt" > now() FOR UPDATE`,
        [claim.intentId, claim.leaseToken],
      );
      if (
        !fenced.rowCount ||
        !(await sourceIsCurrentAndCleared(client, claim.intentId))
      ) {
        await client.query("ROLLBACK");
        return;
      }
      for (const [ordinal, suggestion] of result.suggestions.entries()) {
        await client.query(
          `INSERT INTO "ClipGenerationSuggestion"
            ("id", "intentId", "ordinal", "startMs", "endMs", "title", "rationale", "confidenceBasisPoints")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            claim.intentId,
            ordinal,
            suggestion.startMs,
            suggestion.endMs,
            suggestion.title,
            suggestion.rationale,
            suggestion.confidenceBasisPoints,
          ],
        );
      }
      await client.query(
        `UPDATE "ClipGenerationIntent" SET "state" = 'READY',
           "providerRequestId" = $3, "model" = $4, "leaseToken" = NULL,
           "leaseExpiresAt" = NULL, "updatedAt" = now()
         WHERE "id" = $1 AND "leaseToken" = $2`,
        [
          claim.intentId,
          claim.leaseToken,
          result.providerRequestId,
          result.model,
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

  private async fail(claim: Claim, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE "ClipGenerationIntent" SET
         "state" = CASE WHEN "attemptCount" >= 2 THEN 'FAILED_FINAL'::"ClipGenerationIntentState" ELSE 'QUEUED'::"ClipGenerationIntentState" END,
         "failureCode" = $3, "failureMessage" = $4,
         "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
       WHERE "id" = $1 AND "state" = 'PROCESSING' AND "leaseToken" = $2`,
      [
        claim.intentId,
        claim.leaseToken,
        normalizedCode(message),
        message.slice(0, 1_000),
      ],
    );
  }
}

async function sourceIsCurrentAndCleared(
  client: PoolClient,
  intentId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT i."id" FROM "ClipGenerationIntent" i
      JOIN "Project" p ON p."id" = i."projectId"
      JOIN "VideoSource" s ON s."id" = i."sourceId" AND s."projectId" = i."projectId" AND s."sourceVersion" = i."sourceVersion"
      JOIN "SourceAuthorization" a ON a."sourceId" = s."id" AND a."sourceVersion" = s."sourceVersion"
      WHERE i."id" = $1 AND i."externalTransferAllowed" = TRUE
        AND p."status" = 'SOURCE_READY' AND s."status" = 'READY'
        AND s."durationMs" = i."sourceDurationMs" AND a."status" = 'CLEARED'
      FOR SHARE OF p, s, a`,
    [intentId],
  );
  return result.rows.length === 1;
}

function normalizedCode(message: string): string {
  const code = message.split(":", 1)[0]?.replace(/[^A-Z0-9_]/g, "_");
  return code && code.length <= 120 ? code : "CLIP_GENERATION_FAILED";
}
