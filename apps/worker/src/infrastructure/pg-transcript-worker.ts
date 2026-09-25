import { createHash, randomUUID } from "node:crypto";
import { Pool, types as pgTypes } from "pg";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 2,
      options: "-c timezone=UTC",
      types: {
        // Prisma timestamp(3) values represent UTC. The default node-postgres
        // parser treats timestamp-without-time-zone as worker-local time,
        // which can make a fresh lease look expired outside UTC.
        getTypeParser: (oid, format) =>
          oid === 1114 && format !== "binary"
            ? (value: string) => new Date(`${value.replace(" ", "T")}Z`)
            : pgTypes.getTypeParser(oid, format),
      },
    });
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
    await this.recover(10);
    const client = await this.pool.connect();
    let claim:
      | {
          attemptId: string;
          leaseToken: string;
          objectKey: string;
          fixture: { language: string; segments: TranscriptSegment[] };
          durationMs: number;
          sourceVersion: number;
          sourceSha256: string;
          sourceAuthorizationRevision: number;
          cutPipelineJobId: string;
          cutResultArtifactId: string;
          cutResultSha256: string;
          cutResultSizeBytes: string;
          creatorProfileRevisionId: string;
          creatorProfileRevisionNo: number;
          sourceContextRevisionId: string;
          sourceContextRevisionNo: number;
          cutPromptRevisionId: string;
          cutPromptRevisionNo: number;
          attemptNumber: number;
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
        sourceVersion: number;
        sourceSha256: string;
        sourceAuthorizationRevision: number;
        cutPipelineJobId: string;
        cutResultArtifactId: string;
        cutResultSha256: string;
        cutResultSizeBytes: string;
        creatorProfileRevisionId: string;
        creatorProfileRevisionNo: number;
        sourceContextRevisionId: string;
        sourceContextRevisionNo: number;
        cutPromptRevisionId: string;
        cutPromptRevisionNo: number;
        attemptCount: number;
        retryBudget: number;
        attemptState: string | null;
        leaseActive: boolean;
      }>(
        `SELECT i."id", i."state", i."fixture", i."cutStartMs", i."cutEndMs",
                i."sourceVersion", i."sourceSha256", i."sourceAuthorizationRevision",
                i."cutPipelineJobId", i."cutResultArtifactId", i."cutResultSha256", i."cutResultSizeBytes"::text,
                i."creatorProfileRevisionId", i."creatorProfileRevisionNo",
                i."sourceContextRevisionId", i."sourceContextRevisionNo",
                i."cutPromptRevisionId", i."cutPromptRevisionNo",
                i."attemptCount", i."retryBudget",
                a."state" AS "attemptState",
                COALESCE(a."leaseExpiresAt" > now(), false) AS "leaseActive"
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
      if (
        row.state === "PROCESSING" &&
        row.attemptState === "PROCESSING" &&
        row.leaseActive
      ) {
        await client.query("ROLLBACK");
        return;
      }
      if (
        row.state === "PROCESSING" &&
        row.attemptState === "PROCESSING" &&
        !row.leaseActive
      ) {
        const expiredAttempt = await client.query(
          `UPDATE "TranscriptEvidenceAttempt"
              SET "state" = 'FAILED_FINAL', "finishedAt" = now(),
                  "failureCode" = 'TRANSCRIPT_LEASE_EXPIRED',
                  "failureMessage" = 'Предыдущий AI worker потерял lease.'
            WHERE "intentId" = $1 AND "attemptNumber" = $2
              AND "state" = 'PROCESSING' AND "leaseExpiresAt" <= now()`,
          [intentId, row.attemptCount],
        );
        if (expiredAttempt.rowCount !== 1) {
          await client.query("ROLLBACK");
          return;
        }
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
      const objectKey = `ai-content/transcripts/${intentId}/attempts/${attemptId}/transcript.json`;
      await client.query(
        `INSERT INTO "TranscriptEvidenceAttempt"
          ("id", "intentId", "attemptNumber", "workerId", "leaseToken", "leaseExpiresAt", "workDeadlineAt",
           "objectKey", "cleanupStatus", "nextCleanupAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, now() + interval '30 seconds', now() + interval '120 seconds',
                 $6, 'PENDING', now(), now())`,
        [
          attemptId,
          intentId,
          attemptNumber,
          `ai-worker-${process.pid}`,
          leaseToken,
          objectKey,
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
        objectKey,
        fixture: row.fixture,
        durationMs: row.cutEndMs - row.cutStartMs,
        sourceVersion: row.sourceVersion,
        sourceSha256: row.sourceSha256,
        sourceAuthorizationRevision: row.sourceAuthorizationRevision,
        cutPipelineJobId: row.cutPipelineJobId,
        cutResultArtifactId: row.cutResultArtifactId,
        cutResultSha256: row.cutResultSha256,
        cutResultSizeBytes: row.cutResultSizeBytes,
        creatorProfileRevisionId: row.creatorProfileRevisionId,
        creatorProfileRevisionNo: row.creatorProfileRevisionNo,
        sourceContextRevisionId: row.sourceContextRevisionId,
        sourceContextRevisionNo: row.sourceContextRevisionNo,
        cutPromptRevisionId: row.cutPromptRevisionId,
        cutPromptRevisionNo: row.cutPromptRevisionNo,
        attemptNumber,
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
      if (!(await this.markUploadStarted(claim.attemptId, claim.leaseToken))) {
        await this.reconcileAttemptObject(claim.attemptId);
        return;
      }
      const uploadController = new AbortController();
      const uploadTimer = setTimeout(() => uploadController.abort(), 25_000);
      uploadTimer.unref();
      try {
        await this.storage.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: claim.objectKey,
            Body: bytes,
            ContentType: "application/json",
            Metadata: { sha256 },
          }),
          { abortSignal: uploadController.signal },
        );
        await this.markUploadSettled(claim.attemptId, claim.leaseToken);
      } finally {
        clearTimeout(uploadTimer);
      }
      const finalize = await this.pool.connect();
      try {
        await finalize.query("BEGIN");
        const current = await finalize.query<{
          state: string;
          leaseToken: string;
          leaseActive: boolean;
          deadlineActive: boolean;
          attemptNumber: number;
          attemptCount: number;
        }>(
          `SELECT i."state", a."leaseToken",
                  a."leaseExpiresAt" > now() AS "leaseActive",
                  a."workDeadlineAt" > now() AS "deadlineActive"
                  , a."attemptNumber", i."attemptCount"
             FROM "TranscriptEvidenceIntent" i
             JOIN "TranscriptEvidenceAttempt" a ON a."intentId" = i."id"
            WHERE i."id" = $1 AND a."id" = $2
              AND a."attemptNumber" = i."attemptCount" FOR UPDATE`,
          [intentId, claim.attemptId],
        );
        const currentRow = current.rows[0];
        if (
          !currentRow ||
          currentRow.state !== "PROCESSING" ||
          currentRow.leaseToken !== claim.leaseToken ||
          !currentRow.leaseActive ||
          !currentRow.deadlineActive
        ) {
          await finalize.query("ROLLBACK");
          await this.reconcileAttemptObject(claim.attemptId);
          return;
        }
        const context = await finalize.query(
          `SELECT 1
             FROM "TranscriptEvidenceIntent" i
             JOIN "PipelineJob" j ON j."id" = i."cutPipelineJobId"
             JOIN "VideoSource" s ON s."id" = i."sourceId"
             JOIN "SourceAuthorization" auth ON auth."sourceId" = i."sourceId" AND auth."sourceVersion" = i."sourceVersion"
             JOIN "MediaArtifact" m ON m."id" = i."cutResultArtifactId"
             JOIN "CutEditorialPromptRevision" pr ON pr."id" = i."cutPromptRevisionId"
             JOIN "CutEditorialPrompt" p ON p."id" = pr."promptId"
             JOIN "SourceEditorialContextRevision" cr ON cr."id" = i."sourceContextRevisionId"
             JOIN "SourceEditorialContext" c ON c."id" = cr."contextId"
             JOIN "CreatorProfileRevision" cpr ON cpr."id" = i."creatorProfileRevisionId"
             JOIN "CreatorProfile" cp ON cp."id" = cpr."creatorProfileId"
            WHERE i."id" = $1
              AND s."sourceVersion" = i."sourceVersion" AND s."sha256" = i."sourceSha256"
              AND auth."revision" = i."sourceAuthorizationRevision" AND auth."status" = 'CLEARED'
              AND j."id" = i."cutPipelineJobId" AND j."projectId" = i."projectId" AND j."sourceId" = i."sourceId" AND j."sourceVersion" = i."sourceVersion"
              AND m."id" = i."cutResultArtifactId" AND m."sha256" = i."cutResultSha256" AND m."sizeBytes" = i."cutResultSizeBytes" AND m."pipelineJobId" = j."id"
              AND pr."revision" = i."cutPromptRevisionNo" AND pr."sourceContextRevisionId" = cr."id"
              AND p."cutPipelineJobId" = j."id" AND p."currentRevision" = pr."revision"
              AND cr."revision" = i."sourceContextRevisionNo" AND c."currentRevision" = cr."revision"
              AND cpr."revision" = i."creatorProfileRevisionNo" AND cp."currentRevision" = cpr."revision"`,
          [intentId],
        );
        if (context.rowCount !== 1) {
          const staleAttempt = await finalize.query(
            `UPDATE "TranscriptEvidenceAttempt"
                SET "state" = 'FAILED_FINAL', "finishedAt" = now(),
                    "failureCode" = 'TRANSCRIPT_CONTEXT_STALE',
                    "failureMessage" = 'Контекст или разрешение источника изменились.'
              WHERE "id" = $1 AND "leaseToken" = $2
                AND "state" = 'PROCESSING'
                AND "attemptNumber" = (SELECT "attemptCount" FROM "TranscriptEvidenceIntent" WHERE "id" = $3)`,
            [claim.attemptId, claim.leaseToken, intentId],
          );
          const staleIntent = await finalize.query(
            `UPDATE "TranscriptEvidenceIntent"
                SET "state" = 'FAILED_FINAL', "finishedAt" = now(),
                    "failureCode" = 'TRANSCRIPT_CONTEXT_STALE',
                    "failureMessage" = 'Контекст или разрешение источника изменились.'
              WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $2`,
            [intentId, claim.attemptNumber],
          );
          if (staleAttempt.rowCount !== 1 || staleIntent.rowCount !== 1) {
            throw new Error("TRANSCRIPT_STALE_FINALIZE_LEASE_LOST");
          }
          await finalize.query("COMMIT");
          await this.reconcileAttemptObject(claim.attemptId);
          return;
        }
        const artifactInsert = await finalize.query(
          `INSERT INTO "TranscriptEvidenceArtifact"
          ("id", "intentId", "objectKey", "contentType", "sizeBytes", "sha256", "adapterVersion", "language", "segments")
         VALUES ($1, $2, $3, 'application/json', $4, $5, $6, $7, $8::jsonb)`,
          [
            artifactId,
            intentId,
            claim.objectKey,
            bytes.length,
            sha256,
            LOCAL_TRANSCRIPT_ADAPTER_VERSION,
            claim.fixture.language,
            JSON.stringify(segments),
          ],
        );
        const readyAttempt = await finalize.query(
          `UPDATE "TranscriptEvidenceAttempt" SET "state" = 'READY', "finishedAt" = now(),
             "cleanupStatus" = 'NOT_REQUIRED', "cleanupLastErrorCode" = NULL, "updatedAt" = now()
            WHERE "id" = $1 AND "leaseToken" = $2 AND "state" = 'PROCESSING'`,
          [claim.attemptId, claim.leaseToken],
        );
        const readyIntent = await finalize.query(
          `UPDATE "TranscriptEvidenceIntent" SET "state" = 'READY', "finishedAt" = now()
            WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $2`,
          [intentId, claim.attemptNumber],
        );
        if (
          artifactInsert.rowCount !== 1 ||
          readyAttempt.rowCount !== 1 ||
          readyIntent.rowCount !== 1
        ) {
          throw new Error("TRANSCRIPT_FINALIZE_LEASE_LOST");
        }
        await finalize.query("COMMIT");
      } catch (error) {
        await finalize.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        finalize.release();
      }
    } catch (error) {
      let accepted: boolean;
      try {
        accepted = await this.hasPersistedArtifact(
          intentId,
          claim.attemptId,
          claim.objectKey,
        );
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          "TRANSCRIPT_DELIVERY_OUTCOME_UNKNOWN",
        );
      }
      if (accepted) return;
      const failed = await this.pool.connect();
      try {
        await failed.query("BEGIN");
        const failedAttempt = await failed.query(
          `UPDATE "TranscriptEvidenceAttempt" SET "state" = 'FAILED_FINAL', "finishedAt" = now(),
             "failureCode" = 'TRANSCRIPT_DELIVERY_FAILED', "failureMessage" = $3
           WHERE "id" = $1 AND "leaseToken" = $2 AND "state" = 'PROCESSING'
             AND "attemptNumber" = (SELECT "attemptCount" FROM "TranscriptEvidenceIntent" WHERE "id" = $4)`,
          [
            claim.attemptId,
            claim.leaseToken,
            "TRANSCRIPT_DELIVERY_FAILED",
            intentId,
          ],
        );
        const failedIntent = await failed.query(
          `UPDATE "TranscriptEvidenceIntent"
              SET "state" = CASE WHEN "attemptCount" <= "retryBudget"
                    THEN 'QUEUED'::"TranscriptIntentState"
                    ELSE 'FAILED_FINAL'::"TranscriptIntentState" END,
                  "finishedAt" = CASE WHEN "attemptCount" <= "retryBudget" THEN NULL ELSE now() END,
                  "queuedAt" = CASE WHEN "attemptCount" <= "retryBudget" THEN now() ELSE "queuedAt" END,
                  "failureCode" = CASE WHEN "attemptCount" <= "retryBudget" THEN NULL ELSE 'TRANSCRIPT_DELIVERY_FAILED' END,
                  "failureMessage" = CASE WHEN "attemptCount" <= "retryBudget" THEN NULL ELSE 'Transcript delivery failed.' END
            WHERE "id" = $1 AND "state" = 'PROCESSING' AND "attemptCount" = $2`,
          [intentId, claim.attemptNumber],
        );
        if (failedAttempt.rowCount !== 1 || failedIntent.rowCount !== 1) {
          throw new Error("TRANSCRIPT_FAILURE_LEASE_LOST");
        }
        await failed.query("COMMIT");
      } catch (recordingError) {
        await failed.query("ROLLBACK").catch(() => undefined);
        throw new AggregateError(
          [error, recordingError],
          "TRANSCRIPT_DELIVERY_FAILURE_RECORDING_FAILED",
        );
      } finally {
        failed.release();
      }
      await this.reconcileAttemptObject(claim.attemptId);
      throw error;
    }
  }

  async recover(limit = 50): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const due = await this.pool.query<{ id: string }>(
      `SELECT "id" FROM "TranscriptEvidenceAttempt"
        WHERE "cleanupStatus" = 'PENDING' AND "nextCleanupAt" <= now()
        ORDER BY "nextCleanupAt", "id" LIMIT $1`,
      [boundedLimit],
    );
    for (const row of due.rows) await this.reconcileAttemptObject(row.id);
    return due.rows.length;
  }

  private async markUploadStarted(
    attemptId: string,
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "TranscriptEvidenceAttempt"
          SET "uploadStartedAt" = COALESCE("uploadStartedAt", now()), "updatedAt" = now()
        WHERE "id" = $1 AND "leaseToken" = $2 AND "state" = 'PROCESSING'
          AND "leaseExpiresAt" > now() AND "workDeadlineAt" > now()`,
      [attemptId, leaseToken],
    );
    return result.rowCount === 1;
  }

  private async markUploadSettled(
    attemptId: string,
    leaseToken: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE "TranscriptEvidenceAttempt"
          SET "uploadSettledAt" = COALESCE("uploadSettledAt", now()), "updatedAt" = now()
        WHERE "id" = $1 AND "leaseToken" = $2`,
      [attemptId, leaseToken],
    );
    if (result.rowCount !== 1)
      throw new Error("TRANSCRIPT_UPLOAD_SETTLEMENT_LOST");
  }

  private async hasPersistedArtifact(
    intentId: string,
    attemptId: string,
    objectKey: string,
  ): Promise<boolean> {
    const accepted = await this.pool.query(
      `SELECT 1
         FROM "TranscriptEvidenceArtifact" ar
         JOIN "TranscriptEvidenceAttempt" a ON a."objectKey" = ar."objectKey"
        WHERE a."intentId" = $1 AND a."id" = $2 AND ar."objectKey" = $3`,
      [intentId, attemptId, objectKey],
    );
    return accepted.rowCount === 1;
  }

  private async reconcileAttemptObject(
    attemptId: string,
  ): Promise<"ACCEPTED" | "COMPLETED" | "PENDING"> {
    const reservation = await this.reserveCleanup(attemptId);
    if (reservation.disposition !== "DELETE") return reservation.disposition;
    let deleted = true;
    try {
      await this.storage.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: reservation.objectKey,
        }),
      );
    } catch {
      deleted = false;
    }
    return this.finishCleanupReservation(
      attemptId,
      reservation.cleanupLeaseToken,
      deleted,
      reservation.keepTombstone,
    );
  }

  private async reserveCleanup(attemptId: string): Promise<
    | { disposition: "ACCEPTED" | "COMPLETED" | "PENDING" }
    | {
        disposition: "DELETE";
        objectKey: string;
        cleanupLeaseToken: string;
        keepTombstone: boolean;
      }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        objectKey: string | null;
        cleanupStatus: string;
        uploadStarted: boolean;
        uploadSettled: boolean;
        attemptState: string;
        intentState: string;
        currentAttempt: boolean;
        leaseActive: boolean;
        graceElapsed: boolean;
        cleanupLeaseActive: boolean;
        artifactId: string | null;
      }>(
        `SELECT a."objectKey", a."cleanupStatus",
                a."uploadStartedAt" IS NOT NULL AS "uploadStarted",
                a."uploadSettledAt" IS NOT NULL AS "uploadSettled",
                a."state" AS "attemptState", i."state" AS "intentState",
                a."attemptNumber" = i."attemptCount" AS "currentAttempt",
                a."leaseExpiresAt" > now() AS "leaseActive",
                now() > a."workDeadlineAt" + interval '30 seconds' AS "graceElapsed",
                COALESCE(a."cleanupLeaseExpiresAt" > now(), false) AS "cleanupLeaseActive",
                ar."id" AS "artifactId"
           FROM "TranscriptEvidenceAttempt" a
           JOIN "TranscriptEvidenceIntent" i ON i."id" = a."intentId"
           LEFT JOIN "TranscriptEvidenceArtifact" ar
             ON ar."objectKey" = a."objectKey"
          WHERE a."id" = $1
          FOR UPDATE OF a, i`,
        [attemptId],
      );
      const row = locked.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { disposition: "COMPLETED" };
      }
      if (row.artifactId) {
        await client.query(
          `UPDATE "TranscriptEvidenceAttempt"
              SET "cleanupStatus" = 'NOT_REQUIRED', "cleanupLastErrorCode" = NULL,
                  "cleanupLeaseToken" = NULL, "cleanupLeaseExpiresAt" = NULL,
                  "updatedAt" = now()
            WHERE "id" = $1`,
          [attemptId],
        );
        await client.query("COMMIT");
        return { disposition: "ACCEPTED" };
      }
      if (row.cleanupStatus !== "PENDING") {
        await client.query("COMMIT");
        return { disposition: "COMPLETED" };
      }
      const activeOwner = row.attemptState === "PROCESSING" && row.leaseActive;
      const unknownUploadStillUnsafe =
        row.uploadStarted && !row.uploadSettled && !row.graceElapsed;
      if (activeOwner || unknownUploadStillUnsafe || row.cleanupLeaseActive) {
        await client.query(
          `UPDATE "TranscriptEvidenceAttempt"
              SET "cleanupLastErrorCode" = $2, "nextCleanupAt" = now() + interval '30 seconds',
                  "updatedAt" = now()
            WHERE "id" = $1 AND "cleanupStatus" = 'PENDING'`,
          [
            attemptId,
            activeOwner
              ? "TRANSCRIPT_CLEANUP_ACTIVE_LEASE"
              : unknownUploadStillUnsafe
                ? "TRANSCRIPT_UPLOAD_OUTCOME_UNKNOWN"
                : "TRANSCRIPT_CLEANUP_RESERVED",
          ],
        );
        await client.query("COMMIT");
        return { disposition: "PENDING" };
      }
      if (!row.objectKey || !row.uploadStarted) {
        await client.query(
          `UPDATE "TranscriptEvidenceAttempt"
              SET "cleanupStatus" = 'COMPLETED',
                  "cleanupAttemptCount" = "cleanupAttemptCount" + 1,
                  "cleanupLastErrorCode" = NULL, "cleanupCompletedAt" = now(),
                  "cleanupLeaseToken" = NULL, "cleanupLeaseExpiresAt" = NULL,
                  "updatedAt" = now()
            WHERE "id" = $1 AND "cleanupStatus" = 'PENDING'`,
          [attemptId],
        );
        await client.query("COMMIT");
        return { disposition: "COMPLETED" };
      }
      const cleanupLeaseToken = randomUUID();
      const reserved = await client.query(
        `UPDATE "TranscriptEvidenceAttempt"
            SET "cleanupLeaseToken" = $2,
                "cleanupLeaseExpiresAt" = now() + interval '5 minutes',
                "nextCleanupAt" = now() + interval '5 minutes',
                "updatedAt" = now()
          WHERE "id" = $1 AND "cleanupStatus" = 'PENDING'
            AND ("cleanupLeaseExpiresAt" IS NULL OR "cleanupLeaseExpiresAt" <= now())`,
        [attemptId, cleanupLeaseToken],
      );
      if (reserved.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { disposition: "PENDING" };
      }
      await client.query("COMMIT");
      return {
        disposition: "DELETE",
        objectKey: row.objectKey,
        cleanupLeaseToken,
        keepTombstone: row.uploadStarted && !row.uploadSettled,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async finishCleanupReservation(
    attemptId: string,
    cleanupLeaseToken: string,
    deleted: boolean,
    keepTombstone: boolean,
  ): Promise<"ACCEPTED" | "COMPLETED" | "PENDING"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        cleanupStatus: string;
        cleanupLeaseToken: string | null;
        artifactId: string | null;
      }>(
        `SELECT a."cleanupStatus", a."cleanupLeaseToken", ar."id" AS "artifactId"
           FROM "TranscriptEvidenceAttempt" a
           LEFT JOIN "TranscriptEvidenceArtifact" ar ON ar."objectKey" = a."objectKey"
          WHERE a."id" = $1 FOR UPDATE OF a`,
        [attemptId],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return "COMPLETED";
      }
      if (row.artifactId) {
        await client.query(
          `UPDATE "TranscriptEvidenceAttempt"
              SET "cleanupStatus" = 'NOT_REQUIRED', "cleanupLastErrorCode" = NULL,
                  "cleanupLeaseToken" = NULL, "cleanupLeaseExpiresAt" = NULL,
                  "updatedAt" = now()
            WHERE "id" = $1`,
          [attemptId],
        );
        await client.query("COMMIT");
        return "ACCEPTED";
      }
      if (
        row.cleanupStatus !== "PENDING" ||
        row.cleanupLeaseToken !== cleanupLeaseToken
      ) {
        await client.query("COMMIT");
        return row.cleanupStatus === "COMPLETED" ? "COMPLETED" : "PENDING";
      }
      if (!deleted) {
        await client.query(
          `UPDATE "TranscriptEvidenceAttempt"
              SET "cleanupAttemptCount" = "cleanupAttemptCount" + 1,
                  "cleanupLastErrorCode" = 'TRANSCRIPT_OBJECT_DELETE_FAILED',
                  "cleanupLeaseToken" = NULL, "cleanupLeaseExpiresAt" = NULL,
                  "nextCleanupAt" = now() + interval '30 seconds', "updatedAt" = now()
            WHERE "id" = $1 AND "cleanupStatus" = 'PENDING' AND "cleanupLeaseToken" = $2`,
          [attemptId, cleanupLeaseToken],
        );
        await client.query("COMMIT");
        return "PENDING";
      }
      if (keepTombstone) {
        await client.query(
          `UPDATE "TranscriptEvidenceAttempt"
              SET "cleanupAttemptCount" = "cleanupAttemptCount" + 1,
                  "cleanupLastErrorCode" = 'TRANSCRIPT_UPLOAD_OUTCOME_UNKNOWN',
                  "cleanupLeaseToken" = NULL, "cleanupLeaseExpiresAt" = NULL,
                  "nextCleanupAt" = now() + interval '30 seconds', "updatedAt" = now()
            WHERE "id" = $1 AND "cleanupStatus" = 'PENDING' AND "cleanupLeaseToken" = $2`,
          [attemptId, cleanupLeaseToken],
        );
        await client.query("COMMIT");
        return "PENDING";
      }
      const completed = await client.query(
        `UPDATE "TranscriptEvidenceAttempt"
            SET "cleanupStatus" = 'COMPLETED',
                "cleanupAttemptCount" = "cleanupAttemptCount" + 1,
                "cleanupLastErrorCode" = NULL, "cleanupCompletedAt" = now(),
                "cleanupLeaseToken" = NULL, "cleanupLeaseExpiresAt" = NULL,
                "updatedAt" = now()
          WHERE "id" = $1 AND "cleanupStatus" = 'PENDING' AND "cleanupLeaseToken" = $2`,
        [attemptId, cleanupLeaseToken],
      );
      if (completed.rowCount !== 1) {
        await client.query("ROLLBACK");
        return "PENDING";
      }
      await client.query("COMMIT");
      return "COMPLETED";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.storage.destroy();
  }
}
