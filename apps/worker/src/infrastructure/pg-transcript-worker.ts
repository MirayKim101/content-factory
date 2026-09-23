import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  LOCAL_TRANSCRIPT_ADAPTER_VERSION,
  TRANSCRIPT_CONTRACT_VERSION,
  validateTranscriptSegments,
  type TranscriptSegment,
} from "@content-factory/contracts";

type Config = {
  databaseUrl: string;
  bucket: string;
  storage: {
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
  };
};

/** Local deterministic transcript consumer for the ai-transcript-v1 queue. */
export class PgTranscriptWorker {
  private readonly pool: Pool;
  private readonly storage: S3Client;

  constructor(private readonly config: Config) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
    this.storage = new S3Client({
      endpoint: config.storage.endpoint,
      region: config.storage.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.storage.accessKey,
        secretAccessKey: config.storage.secretKey,
      },
    });
  }

  async process(intentId: string): Promise<void> {
    const client = await this.pool.connect();
    let claim:
      | {
          attemptId: string;
          leaseToken: string;
          workDeadlineAt: Date;
          fixture: { language: string; segments: TranscriptSegment[] };
          durationMs: number;
        }
      | undefined;
    try {
      await client.query("BEGIN");
      const intent = await client.query<{
        id: string;
        state: string;
        fixture: { language: string; segments: TranscriptSegment[] };
        cutStartMs: number;
        cutEndMs: number;
        attemptCount: number;
        retryBudget: number;
        attemptState: string | null;
        leaseExpiresAt: Date;
      }>(
        `SELECT i."id", i."state", i."fixture", i."cutStartMs", i."cutEndMs", i."attemptCount", i."retryBudget",
                a."state" AS "attemptState", a."leaseExpiresAt"
           FROM "TranscriptEvidenceIntent" i
           LEFT JOIN LATERAL (
             SELECT "state", "leaseExpiresAt" FROM "TranscriptEvidenceAttempt"
              WHERE "intentId" = i."id" ORDER BY "attemptNumber" DESC LIMIT 1
           ) a ON TRUE
          WHERE i."id" = $1 FOR UPDATE OF i`,
        [intentId],
      );
      const row = intent.rows[0];
      if (!row || row.state === "READY" || row.state === "FAILED_FINAL") {
        await client.query("ROLLBACK");
        return;
      }
      if (row.state === "PROCESSING" && row.leaseExpiresAt > new Date()) {
        await client.query("ROLLBACK");
        return;
      }
      if (row.attemptCount >= row.retryBudget + 1) {
        await client.query(
          `UPDATE "TranscriptEvidenceIntent" SET "state" = 'FAILED_FINAL', "finishedAt" = now(),
             "failureCode" = 'TRANSCRIPT_RETRY_EXHAUSTED', "failureMessage" = 'Исчерпан лимит попыток транскрипции.'
           WHERE "id" = $1`,
          [intentId],
        );
        await client.query("COMMIT");
        return;
      }
      const attemptId = randomUUID();
      const leaseToken = randomUUID();
      const attemptNumber = row.attemptCount + 1;
      await client.query(
        `INSERT INTO "TranscriptEvidenceAttempt"
          ("id", "intentId", "attemptNumber", "workerId", "leaseToken", "leaseExpiresAt", "workDeadlineAt")
         VALUES ($1, $2, $3, $4, $5, now() + interval '30 seconds', now() + interval '120 seconds')`,
        [
          attemptId,
          intentId,
          attemptNumber,
          `ai-worker-${process.pid}`,
          leaseToken,
        ],
      );
      await client.query(
        `UPDATE "TranscriptEvidenceIntent" SET "state" = 'PROCESSING', "attemptCount" = $2,
          "startedAt" = COALESCE("startedAt", now()), "failureCode" = NULL, "failureMessage" = NULL
         WHERE "id" = $1`,
        [intentId, attemptNumber],
      );
      await client.query("COMMIT");
      claim = {
        attemptId,
        leaseToken,
        workDeadlineAt: new Date(Date.now() + 120_000),
        fixture: row.fixture,
        durationMs: row.cutEndMs - row.cutStartMs,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!claim) return;

    try {
      if (!/^[a-zA-Z]{2,16}(?:-[a-zA-Z]{2,16})?$/.test(claim.fixture.language))
        throw new Error("TRANSCRIPT_LANGUAGE_INVALID");
      if (
        Buffer.byteLength(JSON.stringify(claim.fixture), "utf8") >
        2 * 1024 * 1024
      )
        throw new Error("TRANSCRIPT_FIXTURE_TOO_LARGE");
      const segments = claim.fixture.segments.map((segment) => ({
        ...segment,
        text: segment.text.trim(),
      }));
      validateTranscriptSegments(segments, claim.durationMs);
      const payload = JSON.stringify({
        contractVersion: TRANSCRIPT_CONTRACT_VERSION,
        adapterVersion: LOCAL_TRANSCRIPT_ADAPTER_VERSION,
        language: claim.fixture.language,
        segments,
      });
      const bytes = Buffer.from(payload);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const artifactId = randomUUID();
      const objectKey = `ai-content/transcripts/${intentId}/transcript.json`;
      await this.storage.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: objectKey,
          Body: bytes,
          ContentType: "application/json",
          Metadata: { sha256 },
        }),
      );
      const finalize = await this.pool.connect();
      try {
        await finalize.query("BEGIN");
        const current = await finalize.query<{
          state: string;
          leaseToken: string;
          workDeadlineAt: Date;
        }>(
          `SELECT i."state", a."leaseToken", a."workDeadlineAt"
             FROM "TranscriptEvidenceIntent" i
             JOIN "TranscriptEvidenceAttempt" a ON a."intentId" = i."id"
            WHERE i."id" = $1 AND a."id" = $2 FOR UPDATE`,
          [intentId, claim.attemptId],
        );
        const currentRow = current.rows[0];
        if (
          !currentRow ||
          currentRow.state !== "PROCESSING" ||
          currentRow.leaseToken !== claim.leaseToken ||
          currentRow.workDeadlineAt <= new Date()
        ) {
          await finalize.query("ROLLBACK");
          return;
        }
        await finalize.query(
          `INSERT INTO "TranscriptEvidenceArtifact"
          ("id", "intentId", "objectKey", "contentType", "sizeBytes", "sha256", "adapterVersion", "language", "segments")
         VALUES ($1, $2, $3, 'application/json', $4, $5, $6, $7, $8::jsonb)`,
          [
            artifactId,
            intentId,
            objectKey,
            bytes.length,
            sha256,
            LOCAL_TRANSCRIPT_ADAPTER_VERSION,
            claim.fixture.language,
            JSON.stringify(segments),
          ],
        );
        await finalize.query(
          `UPDATE "TranscriptEvidenceAttempt" SET "state" = 'READY', "finishedAt" = now() WHERE "id" = $1;
         UPDATE "TranscriptEvidenceIntent" SET "state" = 'READY', "finishedAt" = now() WHERE "id" = $2`,
          [claim.attemptId, intentId],
        );
        await finalize.query("COMMIT");
      } catch (error) {
        await finalize.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        finalize.release();
      }
    } catch (error) {
      const failed = await this.pool.connect();
      await failed.query(
        `UPDATE "TranscriptEvidenceAttempt" SET "state" = 'FAILED_FINAL', "finishedAt" = now(),
           "failureCode" = 'TRANSCRIPT_DELIVERY_FAILED', "failureMessage" = $2 WHERE "id" = $1 AND "state" = 'PROCESSING';
         UPDATE "TranscriptEvidenceIntent" SET "state" = CASE WHEN "attemptCount" <= "retryBudget" THEN 'QUEUED' ELSE 'FAILED_FINAL' END,
           "finishedAt" = CASE WHEN "attemptCount" <= "retryBudget" THEN NULL ELSE now() END,
           "queuedAt" = CASE WHEN "attemptCount" <= "retryBudget" THEN now() ELSE "queuedAt" END,
           "failureCode" = CASE WHEN "attemptCount" <= "retryBudget" THEN NULL ELSE 'TRANSCRIPT_DELIVERY_FAILED' END,
           "failureMessage" = CASE WHEN "attemptCount" <= "retryBudget" THEN NULL ELSE 'Transcript delivery failed.' END
         WHERE "id" = $3 AND "state" = 'PROCESSING'`,
        [claim.attemptId, "TRANSCRIPT_DELIVERY_FAILED", intentId],
      );
      failed.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.storage.destroy();
  }
}
