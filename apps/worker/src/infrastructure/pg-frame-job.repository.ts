import { randomUUID } from "node:crypto";
import { Pool, types as pgTypes, type PoolClient } from "pg";
import {
  FRAME_LIMITS,
  FRAME_RESOURCE_CLASS,
  frameRequestedPositions,
  validateFrameMeasurements,
  type FrameMeasurement,
  type FrameProgressPhase,
} from "@content-factory/contracts";
import type {
  ClaimedFrameWork,
  FrameJobRepository,
  FramePreparedOutput,
  FrameWorkPlan,
} from "../application/frame-job-repository.port.js";
import { ControlledMediaError, leaseLostError } from "../domain/media-job.js";
import {
  lockedWorkerFrameContext,
  workerFrameCapture,
} from "./pg-frame-context.js";

type Row = Record<string, unknown>;

export class PgFrameJobRepository implements FrameJobRepository {
  private readonly pool: Pool;
  constructor(
    databaseUrl: string,
    private readonly sourcePolicy: "manual" | "local-auto",
  ) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      options: "-c timezone=UTC",
      types: {
        // Prisma's timestamp(3) columns contain UTC. node-postgres otherwise
        // interprets them in the worker host timezone, changing lease deadlines
        // and captured authorization identity on a non-UTC workstation.
        getTypeParser: (oid, format) =>
          oid === 1114 && format !== "binary"
            ? (value: string) => new Date(`${value.replace(" ", "T")}Z`)
            : pgTypes.getTypeParser(oid, format),
      },
    });
  }
  async close(): Promise<void> {
    await this.pool.end();
  }

  async initializePool(capacity: number): Promise<void> {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16)
      throw new Error("FRAME_CAPACITY_INVALID");
    await this.transaction(async (client) => {
      await client.query(
        'INSERT INTO "FrameExtractionPool" ("resourceClass","capacity") VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [FRAME_RESOURCE_CLASS, capacity],
      );
      const result = await client.query<{ capacity: number }>(
        'SELECT "capacity" FROM "FrameExtractionPool" WHERE "resourceClass"=$1 FOR UPDATE',
        [FRAME_RESOURCE_CLASS],
      );
      if (result.rows[0]?.capacity !== capacity)
        throw new Error("FRAME_CAPACITY_CONFIGURATION_MISMATCH");
      for (let ordinal = 0; ordinal < capacity; ordinal++) {
        await client.query(
          'INSERT INTO "FrameExtractionSlot" ("resourceClass","ordinal") VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [FRAME_RESOURCE_CLASS, ordinal],
        );
      }
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM "FrameExtractionSlot" WHERE "resourceClass"=$1',
        [FRAME_RESOURCE_CLASS],
      );
      if (Number(count.rows[0]?.count) !== capacity)
        throw new Error("FRAME_CAPACITY_CONFIGURATION_MISMATCH");
    });
  }

  async plan(jobId: string): Promise<FrameWorkPlan | null> {
    const result = await this.pool.query<Row>(
      `
      SELECT i.*, m."objectKey" AS "inputObjectKey" FROM "FrameEvidenceIntent" i
      JOIN "PipelineJob" j ON j."id"=i."pipelineJobId" AND j."type"='EXTRACT_EDITORIAL_FRAMES'
      JOIN "MediaArtifact" m ON m."id"=i."cutResultArtifactId" WHERE j."id"=$1`,
      [jobId],
    );
    const row = result.rows[0];
    return row ? planFromRow(row) : null;
  }

  async claim(input: {
    plan: FrameWorkPlan;
    workerId: string;
    leaseMs: number;
    workDeadlineMs: number;
    scratchDirectoryName: string;
    scratchReservedBytes: number;
    availableScratchBytes: number;
  }): Promise<ClaimedFrameWork | null> {
    if (
      input.workDeadlineMs < FRAME_LIMITS.minWorkDeadlineMs ||
      !Number.isSafeInteger(input.workDeadlineMs) ||
      !Number.isSafeInteger(input.scratchReservedBytes) ||
      input.scratchReservedBytes <= FRAME_LIMITS.maxSetBytes
    )
      throw new Error("FRAME_RESERVATION_INVALID");
    return this.transaction(async (client) => {
      await this.lockPool(client);
      const slots = await client.query<Row>(
        'SELECT * FROM "FrameExtractionSlot" WHERE "resourceClass"=$1 ORDER BY "ordinal" FOR UPDATE',
        [FRAME_RESOURCE_CLASS],
      );
      const free = slots.rows.find((slot) => slot.attemptId === null);
      await client.query(
        'SELECT "id" FROM "FrameEvidenceIntent" WHERE "id"=$1 FOR UPDATE',
        [input.plan.intentId],
      );
      const jobs = await client.query<Row>(
        'SELECT *,now() AS "dbNow" FROM "PipelineJob" WHERE "id"=$1 FOR UPDATE',
        [input.plan.jobId],
      );
      const job = jobs.rows[0];
      if (
        !job ||
        !["QUEUED", "RETRY_WAIT"].includes(String(job.state)) ||
        (job.nextAttemptAt &&
          new Date(job.nextAttemptAt as Date).getTime() >
            new Date(job.dbNow as Date).getTime())
      )
        return null;
      const existingSlot = slots.rows.some(
        (slot) => slot.attemptId !== null && slot.leaseToken === job.leaseToken,
      );
      if (existingSlot) return null;
      const reserved = await client.query<{ bytes: string }>(`
        SELECT coalesce(sum(a."scratchReservedBytes"),0)::text AS bytes FROM "FrameEvidenceAttempt" a
        WHERE a."scratchCleanedAt" IS NULL`);
      const enoughScratch =
        input.availableScratchBytes - Number(reserved.rows[0]?.bytes ?? 0) >=
        input.scratchReservedBytes;
      if (!free || !enoughScratch) {
        await client.query(
          `UPDATE "PipelineJob" SET "nextAttemptAt"=now()+interval '5 seconds',
          "admissionReason"=$2,"revision"="revision"+1,"updatedAt"=now() WHERE "id"=$1`,
          [
            input.plan.jobId,
            free ? "FRAME_SCRATCH_UNAVAILABLE" : "FRAME_RESOURCE_BUSY",
          ],
        );
        return null;
      }
      await lockedWorkerFrameContext(
        client,
        input.plan.capture,
        this.sourcePolicy,
      );
      const attemptId = randomUUID();
      const leaseToken = randomUUID();
      const attemptNumber = Number(job.attemptCount) + 1;
      const deadline = new Date(
        new Date(job.dbNow as Date).getTime() + input.workDeadlineMs,
      );
      await client.query(
        `INSERT INTO "JobAttempt" ("id","jobId","attemptNumber","state","workerId","leaseToken","startedAt","heartbeatAt","updatedAt")
        VALUES ($1,$2,$3,'PROCESSING',$4,$5,now(),now(),now())`,
        [
          attemptId,
          input.plan.jobId,
          attemptNumber,
          input.workerId,
          leaseToken,
        ],
      );
      await client.query(
        `INSERT INTO "FrameEvidenceAttempt" ("id","intentId","pipelineJobId","attemptNumber","leaseToken","workDeadlineAt","scratchDirectoryName","scratchReservedBytes")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          attemptId,
          input.plan.intentId,
          input.plan.jobId,
          attemptNumber,
          leaseToken,
          deadline.toISOString(),
          input.scratchDirectoryName,
          input.scratchReservedBytes,
        ],
      );
      await client.query(
        `UPDATE "PipelineJob" SET "state"='PROCESSING',"attemptCount"=$2,"leaseOwner"=$3,"leaseToken"=$4,
        "leaseExpiresAt"=now()+$5*interval '1 millisecond',"heartbeatAt"=now(),"startedAt"=now(),"nextAttemptAt"=NULL,
        "admissionReason"=NULL,"failureCode"=NULL,"failureMessage"=NULL,"failureRetryable"=NULL,"revision"="revision"+1,"updatedAt"=now() WHERE "id"=$1`,
        [
          input.plan.jobId,
          attemptNumber,
          input.workerId,
          leaseToken,
          input.leaseMs,
        ],
      );
      await client.query(
        `UPDATE "FrameExtractionSlot" SET "attemptId"=$3,"leaseToken"=$4,"leaseExpiresAt"=now()+$5*interval '1 millisecond',
        "heartbeatAt"=now(),"workDeadlineAt"=$6 WHERE "resourceClass"=$1 AND "ordinal"=$2`,
        [
          FRAME_RESOURCE_CLASS,
          free.ordinal,
          attemptId,
          leaseToken,
          input.leaseMs,
          deadline.toISOString(),
        ],
      );
      return {
        ...input.plan,
        attemptId,
        attemptNumber,
        leaseToken,
        workDeadlineAt: deadline,
        scratchDirectoryName: input.scratchDirectoryName,
        scratchReservedBytes: input.scratchReservedBytes,
      };
    });
  }

  async rejectPending(
    plan: FrameWorkPlan,
    code: string,
    message: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockPool(client);
      await client.query(
        'SELECT "id" FROM "FrameEvidenceIntent" WHERE "id"=$1 FOR UPDATE',
        [plan.intentId],
      );
      await client.query(
        `UPDATE "PipelineJob" SET "state"='FAILED_FINAL',"failureCode"=$2,"failureMessage"=$3,
        "failureRetryable"=false,"finishedAt"=now(),"nextAttemptAt"=NULL,"revision"="revision"+1,"updatedAt"=now()
        WHERE "id"=$1 AND "state" IN ('QUEUED','RETRY_WAIT')`,
        [plan.jobId, code, message],
      );
    });
  }

  async heartbeat(work: ClaimedFrameWork, leaseMs: number): Promise<boolean> {
    try {
      return await this.transaction(async (client) => {
        await this.lockWork(client, work);
        await client.query(
          'UPDATE "PipelineJob" SET "leaseExpiresAt"=now()+$2*interval \'1 millisecond\',"heartbeatAt"=now(),"updatedAt"=now() WHERE "id"=$1',
          [work.jobId, leaseMs],
        );
        await client.query(
          'UPDATE "FrameExtractionSlot" SET "leaseExpiresAt"=now()+$2*interval \'1 millisecond\',"heartbeatAt"=now() WHERE "attemptId"=$1 AND "leaseToken"=$3',
          [work.attemptId, leaseMs, work.leaseToken],
        );
        await client.query(
          'UPDATE "JobAttempt" SET "heartbeatAt"=now(),"updatedAt"=now() WHERE "id"=$1',
          [work.attemptId],
        );
        return true;
      });
    } catch (error) {
      if (
        error instanceof ControlledMediaError &&
        error.code === "JOB_LEASE_LOST"
      )
        return false;
      throw error;
    }
  }

  async admitInputRead(work: ClaimedFrameWork): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockWork(client, work);
      const fingerprint = await lockedWorkerFrameContext(
        client,
        work.capture,
        this.sourcePolicy,
      );
      if (fingerprint !== work.contextPolicyFingerprint)
        throw new ControlledMediaError(
          "FRAME_CONTEXT_STALE",
          "Контекст изменился.",
          false,
        );
      const updated = await client.query(
        `UPDATE "FrameEvidenceAttempt" SET "inputReadStartedAt"=now(),"inputReadFingerprint"=$3
        WHERE "id"=$1 AND "leaseToken"=$2 AND "inputReadStartedAt" IS NULL AND "executionStoppedAt" IS NULL`,
        [work.attemptId, work.leaseToken, fingerprint],
      );
      if (updated.rowCount !== 1) throw leaseLostError();
    });
  }

  async progress(
    work: ClaimedFrameWork,
    phase: FrameProgressPhase,
    completedFrames: number,
    basisPoints: number,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockWork(client, work);
      await client.query(
        `UPDATE "FrameEvidenceAttempt" SET "progressPhase"=$2,"completedFrameCount"=$3,
        "progressBasisPoints"=greatest("progressBasisPoints",$4),"progressUpdatedAt"=now() WHERE "id"=$1`,
        [work.attemptId, phase, completedFrames, basisPoints],
      );
    });
  }

  async prepareOutput(
    work: ClaimedFrameWork,
    ordinal: number,
  ): Promise<FramePreparedOutput> {
    if (
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= FRAME_LIMITS.count
    )
      throw new Error("FRAME_ORDINAL_INVALID");
    return this.transaction(async (client) => {
      await this.lockWork(client, work);
      const key = `ai-content/frame-evidence/${work.intentId}/attempts/${work.attemptNumber}/frames/${ordinal}`;
      await client.query(
        `INSERT INTO "FrameEvidenceAttemptOutput" ("id","attemptId","intentId","ordinal","objectKey","attemptNumber","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT ("attemptId","ordinal") DO NOTHING`,
        [
          randomUUID(),
          work.attemptId,
          work.intentId,
          ordinal,
          key,
          work.attemptNumber,
        ],
      );
      const output = await client.query<
        FramePreparedOutput & { state: string }
      >(
        'SELECT "id","ordinal","objectKey","state" FROM "FrameEvidenceAttemptOutput" WHERE "attemptId"=$1 AND "ordinal"=$2 FOR UPDATE',
        [work.attemptId, ordinal],
      );
      const row = output.rows[0];
      if (!row || row.state !== "PREPARED" || row.objectKey !== key)
        throw leaseLostError();
      return { id: row.id, ordinal, objectKey: row.objectKey };
    });
  }

  async uploaded(
    work: ClaimedFrameWork,
    output: FramePreparedOutput,
    measurement: FrameMeasurement,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockWork(client, work);
      const result = await client.query(
        `UPDATE "FrameEvidenceAttemptOutput" SET "state"='UPLOADED',"measurement"=$5,"updatedAt"=now()
        WHERE "id"=$1 AND "attemptId"=$2 AND "ordinal"=$3 AND "objectKey"=$4 AND "state"='PREPARED'`,
        [
          output.id,
          work.attemptId,
          measurement.ordinal,
          output.objectKey,
          JSON.stringify(measurement),
        ],
      );
      if (result.rowCount !== 1) throw leaseLostError();
    });
  }

  async uploadSettled(
    work: ClaimedFrameWork,
    output: FramePreparedOutput,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockWork(client, work, false);
      await client.query(
        `UPDATE "FrameEvidenceAttemptOutput" SET "uploadSettledAt"=coalesce("uploadSettledAt",now()),"updatedAt"=now()
        WHERE "id"=$1 AND "attemptId"=$2 AND "objectKey"=$3`,
        [output.id, work.attemptId, output.objectKey],
      );
    });
  }

  async finalize(work: ClaimedFrameWork): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockWork(client, work);
      const outputs = await client.query<{
        id: string;
        ordinal: number;
        state: string;
        measurement: FrameMeasurement;
        objectKey: string;
        uploadSettledAt: Date | null;
      }>(
        'SELECT "id","ordinal","state","measurement","objectKey","uploadSettledAt" FROM "FrameEvidenceAttemptOutput" WHERE "attemptId"=$1 ORDER BY "ordinal" FOR UPDATE',
        [work.attemptId],
      );
      if (
        outputs.rows.length !== 3 ||
        outputs.rows.some(
          (row, index) =>
            row.ordinal !== index ||
            row.state !== "UPLOADED" ||
            !row.measurement ||
            !row.uploadSettledAt ||
            row.objectKey !==
              `ai-content/frame-evidence/${work.intentId}/attempts/${work.attemptNumber}/frames/${index}`,
        )
      ) {
        throw new ControlledMediaError(
          "FRAME_OUTPUT_SET_INCOMPLETE",
          "Набор кадров не прошёл проверку.",
          false,
        );
      }
      try {
        validateFrameMeasurements(
          outputs.rows.map((row) => row.measurement),
          frameRequestedPositions(
            work.capture.cutStartMs,
            work.capture.cutEndMs,
            Number(work.capture.cutResultSizeBytes),
          ),
          work.capture.cutStartMs,
          (work.capture.cutEndMs - work.capture.cutStartMs) * 1000,
        );
      } catch {
        throw new ControlledMediaError(
          "FRAME_OUTPUT_SET_INVALID",
          "Набор кадров не прошёл проверку.",
          false,
        );
      }
      await lockedWorkerFrameContext(client, work.capture, this.sourcePolicy);
      const resultId = randomUUID();
      await client.query(
        'INSERT INTO "FrameEvidenceResult" ("id","intentId","attemptId") VALUES ($1,$2,$3)',
        [resultId, work.intentId, work.attemptId],
      );
      for (const output of outputs.rows) {
        await client.query(
          `INSERT INTO "FrameEvidenceFrame" ("id","resultId","intentId","attemptId","ordinal","outputId","measurement")
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            resultId,
            work.intentId,
            work.attemptId,
            output.ordinal,
            output.id,
            JSON.stringify(output.measurement),
          ],
        );
      }
      await client.query(
        'UPDATE "FrameEvidenceAttemptOutput" SET "state"=\'ACCEPTED\',"cleanupStatus"=\'NOT_REQUIRED\',"updatedAt"=now() WHERE "attemptId"=$1',
        [work.attemptId],
      );
      await client.query(
        'UPDATE "JobAttempt" SET "state"=\'READY\',"finishedAt"=now(),"updatedAt"=now() WHERE "id"=$1',
        [work.attemptId],
      );
      await client.query(
        `UPDATE "PipelineJob" SET "state"='READY',"finishedAt"=now(),"revision"="revision"+1,"updatedAt"=now(),
        "failureCode"=NULL,"failureMessage"=NULL,"failureRetryable"=NULL WHERE "id"=$1`,
        [work.jobId],
      );
      await client.query(
        'UPDATE "FrameEvidenceAttempt" SET "progressPhase"=\'FINALIZE\',"completedFrameCount"=3,"progressBasisPoints"=10000,"progressUpdatedAt"=now() WHERE "id"=$1',
        [work.attemptId],
      );
    });
  }

  async accepted(work: ClaimedFrameWork): Promise<boolean> {
    const result = await this.pool.query<{ count: string }>(
      `
      SELECT count(*) FROM "FrameEvidenceResult" r JOIN "FrameEvidenceFrame" f ON f."resultId"=r."id"
      JOIN "FrameEvidenceAttemptOutput" o ON o."id"=f."outputId" AND o."attemptId"=r."attemptId" AND o."state"='ACCEPTED'
      WHERE r."intentId"=$1 AND r."attemptId"=$2`,
      [work.intentId, work.attemptId],
    );
    return Number(result.rows[0]?.count) === 3;
  }

  /** Caller invokes this only after EVERY child and storage operation settles. */
  async executionStopped(work: ClaimedFrameWork): Promise<void> {
    await this.transaction(async (client) => {
      const job = await this.lockWork(client, work, false);
      await client.query(
        'UPDATE "FrameEvidenceAttempt" SET "executionStoppedAt"=coalesce("executionStoppedAt",now()) WHERE "id"=$1 AND "leaseToken"=$2',
        [work.attemptId, work.leaseToken],
      );
      if (job.state !== "PROCESSING")
        await this.releaseSlot(client, work.attemptId, work.leaseToken);
    });
  }

  async fail(
    work: ClaimedFrameWork,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const job = await this.lockWork(client, work, false);
      if (
        job.state !== "PROCESSING" ||
        Number(job.attemptCount) !== work.attemptNumber ||
        job.leaseToken !== work.leaseToken
      )
        return;
      const deadlineExpired =
        new Date(job.dbNow as Date).getTime() >= work.workDeadlineAt.getTime();
      if (deadlineExpired) {
        code = "FRAME_WORK_DEADLINE_EXCEEDED";
        message = "Превышено время обработки кадров.";
      }
      const retry =
        !deadlineExpired &&
        retryable &&
        work.attemptNumber <= Number(job.retryBudget);
      await client.query(
        `UPDATE "JobAttempt" SET "state"=$2,"failureCode"=$3,"finishedAt"=now(),"updatedAt"=now() WHERE "id"=$1`,
        [work.attemptId, retry ? "FAILED_RETRYABLE" : "FAILED_FINAL", code],
      );
      await client.query(
        `UPDATE "PipelineJob" SET "state"=$2,"failureCode"=$3,"failureMessage"=$4,"failureRetryable"=$5,
        "nextAttemptAt"=CASE WHEN $5 THEN now()+interval '5 seconds' ELSE NULL END,
        "finishedAt"=CASE WHEN $5 THEN NULL ELSE now() END,"revision"="revision"+1,"updatedAt"=now() WHERE "id"=$1`,
        [
          work.jobId,
          retry ? "RETRY_WAIT" : "FAILED_FINAL",
          code,
          message,
          retry,
        ],
      );
    });
  }

  async cleanupCandidates(
    limit: number,
  ): Promise<Array<{ outputId: string; objectKey: string }>> {
    return this.transaction(async (client) => {
      await this.lockPool(client);
      // Lock the same owned rows used by finalization before claiming deletion.
      const candidates = await client.query<Row>(
        `SELECT o."id" AS "outputId",o."objectKey",o."attemptId",a."intentId",a."pipelineJobId"
        FROM "FrameEvidenceAttemptOutput" o JOIN "FrameEvidenceAttempt" a ON a."id"=o."attemptId"
        JOIN "JobAttempt" ja ON ja."id"=a."id"
        WHERE o."cleanupStatus"='PENDING' AND o."state"<>'ACCEPTED' AND o."nextCleanupAt"<=now()
          AND ja."state" IN ('FAILED_RETRYABLE','FAILED_FINAL')
          AND (a."executionStoppedAt" IS NOT NULL OR now()>a."workDeadlineAt"+interval '30 seconds')
        ORDER BY o."createdAt",o."id" LIMIT $1`,
        [limit],
      );
      const claimed: Array<{ outputId: string; objectKey: string }> = [];
      for (const row of candidates.rows) {
        await client.query(
          'SELECT "id" FROM "FrameEvidenceIntent" WHERE "id"=$1 FOR UPDATE',
          [row.intentId],
        );
        await client.query(
          'SELECT "id" FROM "PipelineJob" WHERE "id"=$1 FOR UPDATE',
          [row.pipelineJobId],
        );
        await client.query(
          'SELECT "id" FROM "FrameEvidenceAttempt" WHERE "id"=$1 FOR UPDATE',
          [row.attemptId],
        );
        const changed = await client.query(
          `UPDATE "FrameEvidenceAttemptOutput" SET "state"='CLEANING',"cleanupAttemptCount"="cleanupAttemptCount"+1,"updatedAt"=now(),"nextCleanupAt"=now()+interval '1 minute'
          WHERE "id"=$1 AND "state" IN ('PREPARED','UPLOADED','CLEANING') AND "cleanupStatus"='PENDING'
          AND NOT EXISTS (SELECT 1 FROM "FrameEvidenceFrame" WHERE "outputId"=$1)`,
          [row.outputId],
        );
        if (changed.rowCount === 1)
          claimed.push({
            outputId: String(row.outputId),
            objectKey: String(row.objectKey),
          });
      }
      return claimed;
    });
  }

  async cleaned(outputId: string, errorCode?: string): Promise<void> {
    await this.pool.query(
      `UPDATE "FrameEvidenceAttemptOutput" SET "state"=CASE WHEN $2::text IS NULL AND "uploadSettledAt" IS NOT NULL THEN 'CLEANED' ELSE 'CLEANING' END,
      "cleanupStatus"=CASE WHEN $2::text IS NULL AND "uploadSettledAt" IS NOT NULL THEN 'COMPLETED'::"ArtifactCleanupStatus" ELSE 'PENDING'::"ArtifactCleanupStatus" END,
      "cleanupLastErrorCode"=coalesce($2,CASE WHEN "uploadSettledAt" IS NULL THEN 'FRAME_UPLOAD_OUTCOME_UNKNOWN' ELSE NULL END),
      "nextCleanupAt"=now()+least(86400,60*power(2,least("cleanupAttemptCount",10)))*interval '1 second',
      "cleanupCompletedAt"=CASE WHEN $2::text IS NULL AND "uploadSettledAt" IS NOT NULL THEN now() ELSE NULL END,"updatedAt"=now()
      WHERE "id"=$1 AND "state"='CLEANING' AND "cleanupStatus"='PENDING'`,
      [outputId, errorCode ?? null],
    );
  }

  async recover(limit: number): Promise<void> {
    await this.transaction(async (client) => {
      await this.lockPool(client);
      const slots = await client.query<Row>(
        `SELECT s.*,a."intentId",a."pipelineJobId",a."attemptNumber",a."executionStoppedAt"
        FROM "FrameExtractionSlot" s JOIN "FrameEvidenceAttempt" a ON a."id"=s."attemptId"
        WHERE s."resourceClass"=$1 AND (a."executionStoppedAt" IS NOT NULL OR now()>a."workDeadlineAt"+interval '30 seconds')
        ORDER BY s."ordinal" LIMIT $2 FOR UPDATE OF s`,
        [FRAME_RESOURCE_CLASS, limit],
      );
      for (const slot of slots.rows) {
        await client.query(
          'SELECT "id" FROM "FrameEvidenceIntent" WHERE "id"=$1 FOR UPDATE',
          [slot.intentId],
        );
        const jobs = await client.query<Row>(
          'SELECT * FROM "PipelineJob" WHERE "id"=$1 FOR UPDATE',
          [slot.pipelineJobId],
        );
        await client.query(
          'SELECT "id" FROM "FrameEvidenceAttempt" WHERE "id"=$1 FOR UPDATE',
          [slot.attemptId],
        );
        const job = jobs.rows[0];
        if (job?.state === "PROCESSING" && job.leaseToken === slot.leaseToken) {
          const stoppedBeforeDeadline =
            slot.executionStoppedAt !== null &&
            new Date(slot.executionStoppedAt as Date).getTime() <
              new Date(slot.workDeadlineAt as Date).getTime();
          const retry =
            stoppedBeforeDeadline &&
            Number(job.attemptCount) <= Number(job.retryBudget);
          const failureCode = stoppedBeforeDeadline
            ? "JOB_LEASE_LOST"
            : "FRAME_WORK_DEADLINE_EXCEEDED";
          await client.query(
            'UPDATE "JobAttempt" SET "state"=$2,"failureCode"=$3,"finishedAt"=now(),"updatedAt"=now() WHERE "id"=$1',
            [
              slot.attemptId,
              retry ? "FAILED_RETRYABLE" : "FAILED_FINAL",
              failureCode,
            ],
          );
          await client.query(
            `UPDATE "PipelineJob" SET "state"=$2,"failureCode"=$4,"failureMessage"='Обработка прервана; попытка восстановлена.',
            "failureRetryable"=$3,"nextAttemptAt"=CASE WHEN $3 THEN now() ELSE NULL END,"finishedAt"=CASE WHEN $3 THEN NULL ELSE now() END,
            "revision"="revision"+1,"updatedAt"=now() WHERE "id"=$1`,
            [
              slot.pipelineJobId,
              retry ? "RETRY_WAIT" : "FAILED_FINAL",
              retry,
              failureCode,
            ],
          );
        }
        await this.releaseSlot(
          client,
          String(slot.attemptId),
          String(slot.leaseToken),
        );
      }
    });
  }

  async scratchCandidates(
    limit: number,
  ): Promise<Array<{ attemptId: string; directoryName: string }>> {
    const rows = await this.pool.query<{
      attemptId: string;
      directoryName: string;
    }>(
      `
      SELECT a."id" AS "attemptId",a."scratchDirectoryName" AS "directoryName" FROM "FrameEvidenceAttempt" a
      WHERE a."scratchCleanedAt" IS NULL AND (a."executionStoppedAt" IS NOT NULL OR now()>a."workDeadlineAt"+interval '30 seconds')
      ORDER BY a."createdAt" LIMIT $1`,
      [limit],
    );
    return rows.rows;
  }

  async scratchCleaned(
    attemptId: string,
    directoryName: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE "FrameEvidenceAttempt" SET "scratchCleanedAt"=now() WHERE "id"=$1 AND "scratchDirectoryName"=$2
      AND ("executionStoppedAt" IS NOT NULL OR now()>"workDeadlineAt"+interval '30 seconds')`,
      [attemptId, directoryName],
    );
  }

  private async lockPool(client: PoolClient): Promise<void> {
    const row = await client.query(
      'SELECT "resourceClass" FROM "FrameExtractionPool" WHERE "resourceClass"=$1 FOR UPDATE',
      [FRAME_RESOURCE_CLASS],
    );
    if (row.rowCount !== 1) throw new Error("FRAME_POOL_NOT_INITIALIZED");
  }

  private async lockWork(
    client: PoolClient,
    work: ClaimedFrameWork,
    requireActive = true,
  ): Promise<Row> {
    await this.lockPool(client);
    const slot = await client.query<Row>(
      'SELECT * FROM "FrameExtractionSlot" WHERE "attemptId"=$1 FOR UPDATE',
      [work.attemptId],
    );
    await client.query(
      'SELECT "id" FROM "FrameEvidenceIntent" WHERE "id"=$1 FOR UPDATE',
      [work.intentId],
    );
    const jobs = await client.query<Row>(
      'SELECT *,now() AS "dbNow" FROM "PipelineJob" WHERE "id"=$1 FOR UPDATE',
      [work.jobId],
    );
    const attempts = await client.query<Row>(
      'SELECT * FROM "FrameEvidenceAttempt" WHERE "id"=$1 FOR UPDATE',
      [work.attemptId],
    );
    const job = jobs.rows[0];
    const attempt = attempts.rows[0];
    if (
      !job ||
      !attempt ||
      attempt.leaseToken !== work.leaseToken ||
      attempt.intentId !== work.intentId
    )
      throw leaseLostError();
    if (
      requireActive &&
      (job.state !== "PROCESSING" ||
        job.leaseToken !== work.leaseToken ||
        Number(job.attemptCount) !== work.attemptNumber ||
        slot.rows[0]?.leaseToken !== work.leaseToken ||
        attempt.executionStoppedAt !== null ||
        new Date(job.leaseExpiresAt as Date).getTime() <=
          new Date(job.dbNow as Date).getTime() ||
        new Date(attempt.workDeadlineAt as Date).getTime() <=
          new Date(job.dbNow as Date).getTime())
    )
      throw leaseLostError();
    return job;
  }

  private async releaseSlot(
    client: PoolClient,
    attemptId: string,
    leaseToken: string,
  ): Promise<void> {
    await client.query(
      `UPDATE "FrameExtractionSlot" SET "attemptId"=NULL,"leaseToken"=NULL,"leaseExpiresAt"=NULL,"heartbeatAt"=NULL,"workDeadlineAt"=NULL
      WHERE "attemptId"=$1 AND "leaseToken"=$2`,
      [attemptId, leaseToken],
    );
  }

  private async transaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const result = await action(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (
          attempt >= 4 ||
          !["40001", "40P01"].includes(
            String((error as { code?: string })?.code),
          )
        )
          throw error;
      } finally {
        client.release();
      }
    }
  }
}

function planFromRow(row: Row): FrameWorkPlan {
  return {
    intentId: String(row.id),
    jobId: String(row.pipelineJobId),
    capture: workerFrameCapture(row),
    inputObjectKey: String(row.inputObjectKey),
    contextPolicyFingerprint: String(row.contextPolicyFingerprint),
  };
}
