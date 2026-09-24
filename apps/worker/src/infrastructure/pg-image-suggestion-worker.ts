import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { generateLocalNoLikenessThumbnail } from "./local-no-likeness-thumbnail-adapter.js";

type Storage = {
  uploadBytes(input: { objectKey: string; bytes: Buffer; contentType: string; sha256: string; signal?: AbortSignal }): Promise<{ etag?: string; version?: string }>;
  delete(objectKey: string, signal?: AbortSignal): Promise<void>;
};

type Claim = { intentId: string; attemptId: string; leaseToken: string; contextPolicyFingerprint: string; objectKey: string };

export class PgImageSuggestionWorker {
  private readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly sourceAuthorizationPolicy: "manual" | "local-auto",
    private readonly storage: Storage,
  ) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  async process(intentId: string): Promise<void> {
    const claim = await this.claim(intentId);
    if (!claim) return;
    const candidateId = claim.intentId;
    const objectKey = claim.objectKey;
    let failureCode = "IMAGE_ADAPTER_FAILED";
    try {
      const output = generateLocalNoLikenessThumbnail({ candidateId, seedFingerprint: claim.contextPolicyFingerprint });
      failureCode = "IMAGE_STORAGE_UPLOAD_FAILED";
      if (!(await this.markUploadStarted(claim))) return;
      let receipt: { etag?: string; version?: string };
      try {
        receipt = await this.storage.uploadBytes({ objectKey, bytes: output.bytes, contentType: output.candidate.contentType, sha256: output.candidate.sha256 });
      } finally {
        await this.markUploadSettled(claim);
      }
      failureCode = "IMAGE_FINALIZE_FAILED";
      const accepted = await this.finalize(claim, objectKey, receipt, output);
      if (!accepted) await this.storage.delete(objectKey).catch(() => undefined);
    } catch (error) {
      await this.fail(claim, failureCode);
      await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async recover(limit = 50): Promise<number> {
    await this.cleanupOrphans(Math.max(1, Math.min(500, Math.trunc(limit))));
    const result = await this.pool.query<{ id: string }>(
      `SELECT i."id" FROM "ImageSuggestionIntent" i
       WHERE i."state"='QUEUED' OR (i."state"='PROCESSING' AND NOT EXISTS (
         SELECT 1 FROM "ImageSuggestionAttempt" a WHERE a."intentId"=i."id" AND a."state"='PROCESSING' AND a."leaseExpiresAt">now()))
       ORDER BY i."createdAt", i."id" LIMIT $1`,
      [Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    for (const row of result.rows) await this.process(row.id);
    return result.rows.length;
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async cleanupOrphans(limit: number): Promise<void> {
    const result = await this.pool.query<{ attemptId: string; objectKey: string; uploadStarted: boolean; uploadSettled: boolean }>(
      `SELECT a."id" AS "attemptId",a."objectKey",a."uploadStartedAt" IS NOT NULL AS "uploadStarted",a."uploadSettledAt" IS NOT NULL AS "uploadSettled" FROM "ImageSuggestionAttempt" a
       LEFT JOIN "ImageSuggestionCandidate" c ON c."attemptId"=a."id"
       WHERE a."state"='FAILED_FINAL' AND a."cleanupStatus"='PENDING' AND a."nextCleanupAt"<=now() AND c."id" IS NULL
         AND (a."uploadStartedAt" IS NULL OR a."uploadSettledAt" IS NOT NULL OR now()>a."workDeadlineAt"+interval '30 seconds')
       ORDER BY a."nextCleanupAt",a."id" LIMIT $1`,
      [limit],
    );
    for (const row of result.rows) {
      try {
        await this.storage.delete(row.objectKey);
        await this.pool.query(`UPDATE "ImageSuggestionAttempt" SET
          "cleanupStatus"=CASE WHEN $2::boolean THEN 'COMPLETED'::"ArtifactCleanupStatus" ELSE 'PENDING'::"ArtifactCleanupStatus" END,
          "cleanupCompletedAt"=CASE WHEN $2::boolean THEN now() ELSE NULL END,
          "cleanupLastErrorCode"=CASE WHEN $2::boolean THEN NULL ELSE 'IMAGE_UPLOAD_OUTCOME_UNKNOWN' END,
          "cleanupAttemptCount"="cleanupAttemptCount"+1,
          "nextCleanupAt"=now()+least(86400,60*power(2,least("cleanupAttemptCount"+1,10)))*interval '1 second',"updatedAt"=now()
          WHERE "id"=$1 AND "cleanupStatus"='PENDING'`, [row.attemptId, !row.uploadStarted || row.uploadSettled]);
      } catch {
        await this.pool.query(`UPDATE "ImageSuggestionAttempt" SET "cleanupAttemptCount"="cleanupAttemptCount"+1,"cleanupLastErrorCode"='IMAGE_OBJECT_DELETE_FAILED',"nextCleanupAt"=now()+interval '30 seconds',"updatedAt"=now() WHERE "id"=$1 AND "cleanupStatus"='PENDING'`, [row.attemptId]);
      }
    }
  }

  private async markUploadStarted(claim: Claim): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "ImageSuggestionAttempt" SET "uploadStartedAt"=coalesce("uploadStartedAt",now()),"updatedAt"=now()
       WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING' AND "leaseExpiresAt">now() AND "workDeadlineAt">now()
       RETURNING "id"`,
      [claim.attemptId, claim.leaseToken],
    );
    return result.rowCount === 1;
  }

  private async markUploadSettled(claim: Claim): Promise<void> {
    await this.pool.query(
      `UPDATE "ImageSuggestionAttempt" SET "uploadSettledAt"=coalesce("uploadSettledAt",now()),"updatedAt"=now()
       WHERE "id"=$1 AND "leaseToken"=$2`,
      [claim.attemptId, claim.leaseToken],
    );
  }

  private async claim(intentId: string): Promise<Claim | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<{
        id: string; state: string; contextPolicyFingerprint: string; latestAttemptId: string | null;
        latestAttemptNumber: number | null; latestAttemptState: string | null; latestLeaseActive: boolean; attemptCount: number;
      }>(`SELECT i."id",i."state",i."contextPolicyFingerprint",a."id" AS "latestAttemptId",
          a."attemptNumber" AS "latestAttemptNumber",a."state" AS "latestAttemptState",
          coalesce(a."leaseExpiresAt">now(),false) AS "latestLeaseActive",
          (SELECT count(*)::int FROM "ImageSuggestionAttempt" c WHERE c."intentId"=i."id") AS "attemptCount"
        FROM "ImageSuggestionIntent" i LEFT JOIN LATERAL (
          SELECT * FROM "ImageSuggestionAttempt" x WHERE x."intentId"=i."id" ORDER BY x."attemptNumber" DESC LIMIT 1
        ) a ON TRUE WHERE i."id"=$1 FOR UPDATE OF i`, [intentId]);
      const row = result.rows[0];
      if (!row || row.state === "READY" || row.state === "FAILED_FINAL") { await client.query("ROLLBACK"); return null; }
      if (row.state === "PROCESSING" && row.latestAttemptState === "PROCESSING" && row.latestLeaseActive) { await client.query("ROLLBACK"); return null; }
      if (row.latestAttemptId && row.latestAttemptState === "PROCESSING")
        await client.query(`UPDATE "ImageSuggestionAttempt" SET "state"='FAILED_FINAL',"failureCode"='IMAGE_LEASE_EXPIRED',"failureMessage"='Предыдущий AI worker потерял lease.',"updatedAt"=now() WHERE "id"=$1`, [row.latestAttemptId]);
      if (row.attemptCount >= 2) {
        await client.query(`UPDATE "ImageSuggestionIntent" SET "state"='FAILED_FINAL',"failureCode"='IMAGE_RETRY_EXHAUSTED',"failureMessage"='Исчерпан лимит попыток подготовки обложки.',"updatedAt"=now() WHERE "id"=$1`, [intentId]);
        await client.query("COMMIT"); return null;
      }
      if (!(await currentLineage(client, intentId, this.sourceAuthorizationPolicy))) {
        await client.query(`UPDATE "ImageSuggestionIntent" SET "state"='FAILED_FINAL',"failureCode"='IMAGE_CONTEXT_STALE',"failureMessage"='Редакторский контекст или права изменились.',"updatedAt"=now() WHERE "id"=$1`, [intentId]);
        await client.query("COMMIT"); return null;
      }
      const attemptId = randomUUID(); const leaseToken = randomUUID();
      const objectKey = `ai-content/image-suggestions/${intentId}/attempts/${attemptId}/candidate.png`;
      await client.query(`INSERT INTO "ImageSuggestionAttempt" ("id","intentId","attemptNumber","leaseToken","leaseExpiresAt","workDeadlineAt","objectKey","cleanupStatus","updatedAt") VALUES ($1,$2,$3,$4,now()+interval '30 seconds',now()+interval '120 seconds',$5,'PENDING',now())`, [attemptId,intentId,(row.latestAttemptNumber ?? 0)+1,leaseToken,objectKey]);
      await client.query(`UPDATE "ImageSuggestionIntent" SET "state"='PROCESSING',"failureCode"=NULL,"failureMessage"=NULL,"updatedAt"=now() WHERE "id"=$1`, [intentId]);
      await client.query("COMMIT");
      return { intentId, attemptId, leaseToken, contextPolicyFingerprint: row.contextPolicyFingerprint, objectKey };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async finalize(claim: Claim, objectKey: string, receipt: { etag?: string; version?: string }, output: ReturnType<typeof generateLocalNoLikenessThumbnail>): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const active = await client.query<{ state: string; leaseToken: string; leaseActive: boolean; deadlineActive: boolean }>(
        `SELECT i."state",a."leaseToken",a."leaseExpiresAt">now() AS "leaseActive",a."workDeadlineAt">now() AS "deadlineActive"
         FROM "ImageSuggestionIntent" i JOIN "ImageSuggestionAttempt" a ON a."intentId"=i."id"
         WHERE i."id"=$1 AND a."id"=$2 FOR UPDATE OF i,a`, [claim.intentId,claim.attemptId]);
      const row = active.rows[0];
      if (!row || row.state !== "PROCESSING" || row.leaseToken !== claim.leaseToken || !row.leaseActive || !row.deadlineActive) { await client.query("ROLLBACK"); return false; }
      if (!(await currentLineage(client, claim.intentId, this.sourceAuthorizationPolicy))) {
        await this.markStale(client, claim); await client.query("COMMIT"); return false;
      }
      await client.query(`INSERT INTO "ImageSuggestionCandidate" ("id","intentId","attemptId","objectKey","contentType","sizeBytes","sha256","width","height","storageEtag","storageVersion","contractVersion","adapterVersion","promptBasisVersion","likeness","safetyDecision","directCostMicrousd","costBasisVersion")
        VALUES ($1,$2,$3,$4,$5,$6,$7,1280,720,$8,$9,$10,$11,$12,'NONE',$13::jsonb,0,$14) ON CONFLICT ("intentId") DO NOTHING`,
        [output.candidate.id,claim.intentId,claim.attemptId,objectKey,output.candidate.contentType,output.candidate.sizeBytes,output.candidate.sha256,receipt.etag ?? null,receipt.version ?? null,output.candidate.contractVersion,output.candidate.adapterVersion,output.candidate.promptBasisVersion,JSON.stringify(output.safetyDecision),output.costBasisVersion]);
      await client.query(`UPDATE "ImageSuggestionAttempt" SET "state"='READY',"cleanupStatus"='NOT_REQUIRED',"updatedAt"=now() WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING'`, [claim.attemptId,claim.leaseToken]);
      await client.query(`UPDATE "ImageSuggestionIntent" SET "state"='READY',"updatedAt"=now() WHERE "id"=$1 AND "state"='PROCESSING'`, [claim.intentId]);
      await client.query("COMMIT"); return true;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async markStale(client: PoolClient, claim: Claim) {
    await client.query(`UPDATE "ImageSuggestionAttempt" SET "state"='FAILED_FINAL',"failureCode"='IMAGE_CONTEXT_STALE',"failureMessage"='Редакторский контекст или права изменились.',"updatedAt"=now() WHERE "id"=$1 AND "leaseToken"=$2`, [claim.attemptId,claim.leaseToken]);
    await client.query(`UPDATE "ImageSuggestionIntent" SET "state"='FAILED_FINAL',"failureCode"='IMAGE_CONTEXT_STALE',"failureMessage"='Редакторский контекст или права изменились.',"updatedAt"=now() WHERE "id"=$1`, [claim.intentId]);
  }

  private async fail(claim: Claim, code: string) {
    const client = await this.pool.connect();
    try { await client.query("BEGIN");
      const failed = await client.query(`UPDATE "ImageSuggestionAttempt" SET "state"='FAILED_FINAL',"failureCode"=$3,"failureMessage"='Локальный adapter не подготовил обложку.',"updatedAt"=now() WHERE "id"=$1 AND "leaseToken"=$2 AND "state"='PROCESSING' AND "leaseExpiresAt">now() AND "workDeadlineAt">now() RETURNING "id"`, [claim.attemptId,claim.leaseToken,code]);
      if (failed.rowCount === 1)
        await client.query(`UPDATE "ImageSuggestionIntent" SET "state"='FAILED_FINAL',"failureCode"=$2,"failureMessage"='Локальный adapter не подготовил обложку.',"updatedAt"=now() WHERE "id"=$1 AND "state"='PROCESSING'`, [claim.intentId,code]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
}

async function currentLineage(client: PoolClient, intentId: string, policy: "manual" | "local-auto"): Promise<boolean> {
  const result = await client.query<{ id: string }>(`SELECT i."id" FROM "ImageSuggestionIntent" i
    JOIN "PipelineJob" j ON j."id"=i."cutPipelineJobId"
    JOIN "MediaArtifact" m ON m."id"=i."cutResultArtifactId"
    JOIN "VideoSource" s ON s."id"=i."sourceId" AND s."sourceVersion"=i."sourceVersion"
    JOIN "SourceAuthorization" sa ON sa."sourceId"=s."id" AND sa."sourceVersion"=s."sourceVersion"
    JOIN "CreatorProfileRevision" cpr ON cpr."id"=i."creatorProfileRevisionId" AND cpr."creatorProfileId"=i."creatorProfileId" AND cpr."revision"=i."creatorProfileRevisionNo"
    JOIN "CreatorProfile" cp ON cp."id"=cpr."creatorProfileId" AND cp."currentRevision"=cpr."revision"
    JOIN "SourceEditorialContextRevision" scr ON scr."id"=i."sourceContextRevisionId" AND scr."contextId"=i."sourceContextId" AND scr."revision"=i."sourceContextRevisionNo"
    JOIN "SourceEditorialContext" sc ON sc."id"=scr."contextId" AND sc."currentRevision"=scr."revision"
    JOIN "CutEditorialPromptRevision" pr ON pr."id"=i."cutPromptRevisionId" AND pr."promptId"=i."cutPromptId" AND pr."revision"=i."cutPromptRevisionNo"
    JOIN "CutEditorialPrompt" p ON p."id"=pr."promptId" AND p."currentRevision"=pr."revision"
    JOIN "CutSegment" cs ON cs."jobId"=j."id"
    WHERE i."id"=$1 AND s."status"='READY' AND s."sha256"=i."sourceSha256"
      AND sa."revision"=i."sourceAuthorizationRevision" AND sa."status"='CLEARED' AND sa."basis"::text=i."sourceAuthorizationBasis"
      AND (sa."basis"::text<>'LOCAL_DEVELOPMENT_AUTO' OR $2='local-auto')
      AND sa."declarationVersion"=i."sourceAuthorizationDeclarationVersion" AND sa."decidedAt"=i."sourceAuthorizationDecidedAt"
      AND j."type"='CUT_SEGMENT' AND j."state"='READY' AND j."projectId"=i."projectId" AND j."sourceId"=i."sourceId" AND j."sourceVersion"=i."sourceVersion"
      AND m."status"='READY' AND m."role"='CUT_RESULT' AND m."pipelineJobId"=j."id" AND m."sha256"=i."cutResultSha256" AND m."sizeBytes"=i."cutResultSizeBytes"
      AND cs."startMs"=i."cutStartMs" AND cs."endMs"=i."cutEndMs"
      AND scr."projectId"=i."projectId" AND scr."sourceId"=i."sourceId" AND scr."sourceVersion"=i."sourceVersion"
      AND pr."projectId"=i."projectId" AND pr."sourceId"=i."sourceId" AND pr."sourceVersion"=i."sourceVersion"
      AND p."cutPipelineJobId"=i."cutPipelineJobId" AND p."cutResultArtifactId"=i."cutResultArtifactId"
    FOR SHARE OF j,m,s,sa,cpr,cp,scr,sc,pr,p,cs`, [intentId,policy]);
  return result.rows.length === 1;
}
