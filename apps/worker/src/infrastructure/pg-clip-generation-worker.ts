import { randomUUID } from "node:crypto";

import {
  validateClipGenerationRequest,
  type ClipGenerationRequest,
} from "@content-factory/contracts";
import { Pool, type PoolClient } from "pg";
import { workerPgPoolConfig } from "./worker-pg-pool.js";

import type { ClipGenerationProvider } from "../application/clip-generation-provider.port.js";

type Claim = Readonly<{
  intentId: string;
  leaseToken: string;
  request: ClipGenerationRequest;
}>;

class ClipGenerationShutdownError extends Error {}

export class PgClipGenerationWorker {
  private readonly pool: Pool;
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;

  constructor(
    databaseUrl: string,
    private readonly provider: ClipGenerationProvider,
    private readonly leaseMs = 150_000,
  ) {
    this.pool = new Pool(workerPgPoolConfig(databaseUrl, 2));
  }

  async process(intentId: string): Promise<void> {
    if (this.stopping) return;
    const claim = await this.claim(intentId);
    if (!claim) return;
    if (this.stopping) {
      await this.release(claim).catch(() => false);
      return;
    }
    const abort = new AbortController();
    this.activeControllers.add(abort);
    let heartbeatRunning = false;
    const heartbeat = setInterval(
      () => {
        if (heartbeatRunning || abort.signal.aborted) return;
        heartbeatRunning = true;
        void this.heartbeat(claim)
          .then((active) => {
            if (!active) abort.abort(new Error("CLIP_GENERATION_LEASE_LOST"));
          })
          .catch(() =>
            abort.abort(new Error("CLIP_GENERATION_HEARTBEAT_FAILED")),
          )
          .finally(() => (heartbeatRunning = false));
      },
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      const result = await this.provider.generate(claim.request, abort.signal);
      await this.finalize(claim, result);
    } catch (error) {
      if (abort.signal.reason instanceof ClipGenerationShutdownError) {
        await this.release(claim).catch(() => false);
        return;
      }
      await this.fail(
        claim,
        error instanceof Error ? error.message : "CLIP_GENERATION_FAILED",
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.activeControllers.delete(abort);
    }
  }

  abortAll(): void {
    this.stopping = true;
    for (const controller of this.activeControllers)
      controller.abort(new ClipGenerationShutdownError());
  }

  async recover(limit = 20): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT "id" FROM "ClipGenerationIntent"
        WHERE "provider" = $1 AND "model" = $2 AND "promptVersion" = $3
          AND ("state" = 'QUEUED'
           OR ("state" = 'PROCESSING' AND "leaseExpiresAt" <= now())
        ) ORDER BY "createdAt", "id" LIMIT $4`,
      [
        this.provider.provider,
        this.provider.model,
        this.provider.promptVersion,
        Math.max(1, Math.min(100, Math.trunc(limit))),
      ],
    );
    for (const row of result.rows)
      await this.process(row.id).catch(() => undefined);
    return result.rows.length;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async heartbeat(claim: Claim): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "ClipGenerationIntent" SET
         "leaseExpiresAt"=now()+$3 * interval '1 millisecond', "updatedAt"=now()
       WHERE "id"=$1 AND "state"='PROCESSING' AND "leaseToken"=$2
         AND "leaseExpiresAt">now()`,
      [claim.intentId, claim.leaseToken, this.leaseMs],
    );
    return result.rowCount === 1;
  }

  private async release(claim: Claim): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "ClipGenerationIntent" SET "state"='QUEUED',
         "attemptCount"=GREATEST("attemptCount"-1,0),
         "leaseToken"=NULL, "leaseExpiresAt"=NULL, "updatedAt"=now()
       WHERE "id"=$1 AND "state"='PROCESSING' AND "leaseToken"=$2`,
      [claim.intentId, claim.leaseToken],
    );
    return result.rowCount === 1;
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
          WHERE i."id" = $1 AND i."provider" = $2 AND i."model" = $3
            AND i."promptVersion" = $4 FOR UPDATE`,
        [
          intentId,
          this.provider.provider,
          this.provider.model,
          this.provider.promptVersion,
        ],
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
          AND "provider" = $3 AND "model" = $4 AND "promptVersion" = $5
          AND "leaseExpiresAt" > now() FOR UPDATE`,
        [
          claim.intentId,
          claim.leaseToken,
          this.provider.provider,
          this.provider.model,
          this.provider.promptVersion,
        ],
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
           "providerRequestId" = $3, "leaseToken" = NULL,
           "leaseExpiresAt" = NULL, "updatedAt" = now()
         WHERE "id" = $1 AND "leaseToken" = $2`,
        [claim.intentId, claim.leaseToken, result.providerRequestId],
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
        AND a."basis" IS NOT NULL AND a."basis" <> 'LOCAL_DEVELOPMENT_AUTO'
      FOR SHARE OF p, s, a`,
    [intentId],
  );
  return result.rows.length === 1;
}

function normalizedCode(message: string): string {
  const code = message.split(":", 1)[0]?.replace(/[^A-Z0-9_]/g, "_");
  return code && code.length <= 120 ? code : "CLIP_GENERATION_FAILED";
}
