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
      }>(
        `SELECT "id", "state", "fixture", "cutStartMs", "cutEndMs", "attemptCount", "retryBudget"
         FROM "TranscriptEvidenceIntent" WHERE "id" = $1 FOR UPDATE`,
        [intentId],
      );
      const row = intent.rows[0];
      if (!row || row.state === "READY" || row.state === "FAILED_FINAL") {
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
          randomUUID(),
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
      await finalize.query("BEGIN");
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
      finalize.release();
    } catch (error) {
      const failed = await this.pool.connect();
      await failed.query(
        `UPDATE "TranscriptEvidenceAttempt" SET "state" = 'FAILED_FINAL', "finishedAt" = now(),
           "failureCode" = 'TRANSCRIPT_DELIVERY_FAILED', "failureMessage" = $2 WHERE "id" = $1;
         UPDATE "TranscriptEvidenceIntent" SET "state" = 'FAILED_FINAL', "finishedAt" = now(),
           "failureCode" = 'TRANSCRIPT_DELIVERY_FAILED', "failureMessage" = $2 WHERE "id" = $3`,
        [
          claim.attemptId,
          error instanceof Error ? error.message : "unknown",
          intentId,
        ],
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
