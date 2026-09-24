import { randomUUID } from "node:crypto";

import {
  LOCAL_RESEARCH_ADAPTER_VERSION,
  LOCAL_RESEARCH_COST_BASIS_VERSION,
  RESEARCH_CONTRACT_VERSION,
  validateResearchSnapshot,
  type ResearchCitation,
  type ResearchSnapshot,
} from "@content-factory/contracts";
import { Pool, type PoolClient } from "pg";

type IntentRow = {
  id: string;
  state: "QUEUED" | "PROCESSING" | "READY" | "FAILED_FINAL";
  transcriptIntentId: string;
  sourceContextRevisionId: string;
  query: string;
  adapterVersion: string;
  searchedAt: Date;
  freshUntil: Date;
  freshnessPolicyVersion: string;
  latestAttemptId: string | null;
  latestAttemptNumber: number | null;
  latestAttemptState: string | null;
  latestLeaseActive: boolean;
  attemptCount: number;
};

type Claim = {
  intentId: string;
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  sourceTitle: string;
  snapshot: ResearchSnapshot;
};

export class PgResearchWorker {
  private readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly sourceAuthorizationPolicy: "manual" | "local-auto",
  ) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  async process(intentId: string): Promise<void> {
    const claim = await this.claim(intentId);
    if (!claim) return;
    try {
      validateResearchSnapshot(claim.snapshot);
      const title = claim.sourceTitle.trim().slice(0, 200);
      if (!title) throw new Error("RESEARCH_SOURCE_TITLE_REQUIRED");
      const citationIds = claim.snapshot.citations.map((item) => item.id);
      const suggestion = {
        id: randomUUID(),
        title,
        description: `Редакторская заготовка по теме «${claim.snapshot.query.slice(0, 180)}». Проверьте факты и отредактируйте перед экспортом.`,
        tags: [
          ...new Set(claim.snapshot.citations.map((item) => item.publisher)),
        ].slice(0, 30),
        basisVersion: `${RESEARCH_CONTRACT_VERSION}:${LOCAL_RESEARCH_ADAPTER_VERSION}`,
        citationIds,
        claims: [] as Array<{ text: string; citationIds: string[] }>,
      };
      await this.finalize(claim, suggestion);
    } catch (error) {
      await this.fail(
        claim,
        error instanceof Error ? error.message : "RESEARCH_GENERATION_FAILED",
      );
      throw error;
    }
  }

  async recover(limit = 50): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.pool.query<{ id: string }>(
      `SELECT i."id"
         FROM "ResearchSuggestionIntent" i
        WHERE i."state" = 'QUEUED'
           OR (i."state" = 'PROCESSING' AND NOT EXISTS (
             SELECT 1 FROM "ResearchSuggestionAttempt" a
              WHERE a."intentId" = i."id" AND a."state" = 'PROCESSING'
                AND a."leaseExpiresAt" > now()
           ))
        ORDER BY i."createdAt" ASC, i."id" ASC
        LIMIT $1`,
      [boundedLimit],
    );
    for (const row of result.rows) await this.process(row.id);
    return result.rows.length;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async claim(intentId: string): Promise<Claim | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<IntentRow>(
        `SELECT i."id", i."state", i."transcriptIntentId", i."sourceContextRevisionId",
                i."query", i."adapterVersion", i."searchedAt", i."freshUntil",
                i."freshnessPolicyVersion", a."id" AS "latestAttemptId",
                a."attemptNumber" AS "latestAttemptNumber", a."state" AS "latestAttemptState",
                COALESCE(a."leaseExpiresAt" > now(), false) AS "latestLeaseActive",
                (SELECT count(*)::int FROM "ResearchSuggestionAttempt" c WHERE c."intentId" = i."id") AS "attemptCount"
           FROM "ResearchSuggestionIntent" i
           LEFT JOIN LATERAL (
             SELECT * FROM "ResearchSuggestionAttempt" r
              WHERE r."intentId" = i."id" ORDER BY r."attemptNumber" DESC LIMIT 1
           ) a ON TRUE
          WHERE i."id" = $1 FOR UPDATE OF i`,
        [intentId],
      );
      const row = result.rows[0];
      if (!row || row.state === "READY" || row.state === "FAILED_FINAL") {
        await client.query("ROLLBACK");
        return null;
      }
      if (
        row.state === "PROCESSING" &&
        row.latestAttemptState === "PROCESSING" &&
        row.latestLeaseActive
      ) {
        await client.query("ROLLBACK");
        return null;
      }
      if (row.latestAttemptId && row.latestAttemptState === "PROCESSING") {
        await client.query(
          `UPDATE "ResearchSuggestionAttempt" SET "state" = 'FAILED_FINAL',
             "failureCode" = 'RESEARCH_LEASE_EXPIRED', "failureMessage" = 'Предыдущий AI worker потерял lease.'
           WHERE "id" = $1 AND "state" = 'PROCESSING'`,
          [row.latestAttemptId],
        );
      }
      if (row.attemptCount >= 2) {
        await client.query(
          `UPDATE "ResearchSuggestionIntent" SET "state" = 'FAILED_FINAL',
             "failureCode" = 'RESEARCH_RETRY_EXHAUSTED',
             "failureMessage" = 'Исчерпан лимит попыток подготовки метаданных.'
           WHERE "id" = $1`,
          [intentId],
        );
        await client.query("COMMIT");
        return null;
      }
      if (
        !(await currentLineage(
          client,
          intentId,
          this.sourceAuthorizationPolicy,
        ))
      ) {
        await client.query(
          `UPDATE "ResearchSuggestionIntent" SET "state" = 'FAILED_FINAL',
             "failureCode" = 'RESEARCH_CONTEXT_STALE',
             "failureMessage" = 'Редакторский контекст или права изменились.'
           WHERE "id" = $1`,
          [intentId],
        );
        await client.query("COMMIT");
        return null;
      }
      const context = await client.query<{ sourceTitle: string }>(
        `SELECT "sourceTitle" FROM "SourceEditorialContextRevision" WHERE "id" = $1`,
        [row.sourceContextRevisionId],
      );
      const citations = await client.query<{
        id: string;
        url: string;
        title: string;
        publisher: string;
        publishedAt: Date | null;
        accessedAt: Date;
        excerpt: string;
        checksum: string;
      }>(
        `SELECT "id", "url", "title", "publisher", "publishedAt", "accessedAt", "excerpt", "checksum"
           FROM "ResearchCitation" WHERE "intentId" = $1 ORDER BY "ordinal" ASC`,
        [intentId],
      );
      const attemptId = randomUUID();
      const leaseToken = randomUUID();
      const attemptNumber = (row.latestAttemptNumber ?? 0) + 1;
      await client.query(
        `INSERT INTO "ResearchSuggestionAttempt"
          ("id", "intentId", "attemptNumber", "leaseToken", "leaseExpiresAt", "workDeadlineAt", "updatedAt")
         VALUES ($1, $2, $3, $4, now() + interval '30 seconds', now() + interval '120 seconds', now())`,
        [attemptId, intentId, attemptNumber, leaseToken],
      );
      await client.query(
        `UPDATE "ResearchSuggestionIntent" SET "state" = 'PROCESSING',
           "failureCode" = NULL, "failureMessage" = NULL, "updatedAt" = now()
         WHERE "id" = $1`,
        [intentId],
      );
      await client.query("COMMIT");
      return {
        intentId,
        attemptId,
        attemptNumber,
        leaseToken,
        sourceTitle: context.rows[0]?.sourceTitle ?? "",
        snapshot: {
          contractVersion: RESEARCH_CONTRACT_VERSION,
          adapterVersion: row.adapterVersion,
          query: row.query,
          freshness: row.freshUntil >= new Date() ? "CURRENT" : "STALE",
          citations: citations.rows.map((citation): ResearchCitation => ({
            ...citation,
            publishedAt: citation.publishedAt?.toISOString() ?? null,
            accessedAt: citation.accessedAt.toISOString(),
          })),
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async finalize(
    claim: Claim,
    suggestion: {
      id: string;
      title: string;
      description: string;
      tags: string[];
      basisVersion: string;
      citationIds: string[];
      claims: Array<{ text: string; citationIds: string[] }>;
    },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const current = await client.query<{
        state: string;
        leaseToken: string;
        leaseActive: boolean;
        deadlineActive: boolean;
      }>(
        `SELECT i."state", a."leaseToken",
                a."leaseExpiresAt" > now() AS "leaseActive",
                a."workDeadlineAt" > now() AS "deadlineActive"
           FROM "ResearchSuggestionIntent" i
           JOIN "ResearchSuggestionAttempt" a ON a."intentId" = i."id"
          WHERE i."id" = $1 AND a."id" = $2 FOR UPDATE OF i, a`,
        [claim.intentId, claim.attemptId],
      );
      const row = current.rows[0];
      if (
        !row ||
        row.state !== "PROCESSING" ||
        row.leaseToken !== claim.leaseToken ||
        !row.leaseActive ||
        !row.deadlineActive
      ) {
        await client.query("ROLLBACK");
        return;
      }
      if (
        !(await currentLineage(
          client,
          claim.intentId,
          this.sourceAuthorizationPolicy,
        ))
      ) {
        await client.query(
          `UPDATE "ResearchSuggestionAttempt" SET "state" = 'FAILED_FINAL',
             "failureCode" = 'RESEARCH_CONTEXT_STALE',
             "failureMessage" = 'Редакторский контекст или права изменились.', "updatedAt" = now()
           WHERE "id" = $1 AND "leaseToken" = $2 AND "state" = 'PROCESSING'`,
          [claim.attemptId, claim.leaseToken],
        );
        await client.query(
          `UPDATE "ResearchSuggestionIntent" SET "state" = 'FAILED_FINAL',
             "failureCode" = 'RESEARCH_CONTEXT_STALE',
             "failureMessage" = 'Редакторский контекст или права изменились.', "updatedAt" = now()
           WHERE "id" = $1 AND "state" = 'PROCESSING'`,
          [claim.intentId],
        );
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `INSERT INTO "ResearchSuggestionSet"
          ("id", "intentId", "attemptId", "title", "description", "tags", "claims",
           "citationIds", "basisVersion", "directCostMicrousd", "costBasisVersion")
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,0,$10)
         ON CONFLICT ("intentId") DO NOTHING`,
        [
          suggestion.id,
          claim.intentId,
          claim.attemptId,
          suggestion.title,
          suggestion.description,
          JSON.stringify(suggestion.tags),
          JSON.stringify(suggestion.claims),
          JSON.stringify(suggestion.citationIds),
          suggestion.basisVersion,
          LOCAL_RESEARCH_COST_BASIS_VERSION,
        ],
      );
      await client.query(
        `UPDATE "ResearchSuggestionAttempt" SET "state" = 'READY', "updatedAt" = now()
          WHERE "id" = $1 AND "leaseToken" = $2 AND "state" = 'PROCESSING'`,
        [claim.attemptId, claim.leaseToken],
      );
      await client.query(
        `UPDATE "ResearchSuggestionIntent" SET "state" = 'READY', "updatedAt" = now()
          WHERE "id" = $1 AND "state" = 'PROCESSING'`,
        [claim.intentId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async fail(claim: Claim, code: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query(
        `UPDATE "ResearchSuggestionAttempt" SET "state" = 'FAILED_FINAL',
           "failureCode" = $3, "failureMessage" = 'Локальный adapter не подготовил варианты.', "updatedAt" = now()
         WHERE "id" = $1 AND "leaseToken" = $2 AND "state" = 'PROCESSING'`,
        [claim.attemptId, claim.leaseToken, code],
      );
      await client.query(
        `UPDATE "ResearchSuggestionIntent" SET "state" = 'FAILED_FINAL',
           "failureCode" = $2, "failureMessage" = 'Локальный adapter не подготовил варианты.', "updatedAt" = now()
         WHERE "id" = $1 AND "state" = 'PROCESSING'`,
        [claim.intentId, code],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function currentLineage(
  client: PoolClient,
  intentId: string,
  sourceAuthorizationPolicy: "manual" | "local-auto",
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `SELECT i."id"
         FROM "ResearchSuggestionIntent" i
         JOIN "TranscriptEvidenceIntent" t ON t."id" = i."transcriptIntentId"
         JOIN "TranscriptEvidenceArtifact" ta ON ta."intentId" = t."id"
         JOIN "PipelineJob" j ON j."id" = t."cutPipelineJobId"
         JOIN "MediaArtifact" m ON m."id" = t."cutResultArtifactId"
         JOIN "VideoSource" s ON s."id" = t."sourceId" AND s."sourceVersion" = t."sourceVersion"
         JOIN "SourceAuthorization" sa ON sa."sourceId" = s."id" AND sa."sourceVersion" = s."sourceVersion"
         JOIN "SourceEditorialContextRevision" scr ON scr."id" = t."sourceContextRevisionId"
         JOIN "SourceEditorialContext" sc ON sc."id" = scr."contextId" AND sc."currentRevision" = scr."revision"
         JOIN "CreatorProfileRevision" cpr ON cpr."id" = t."creatorProfileRevisionId"
         JOIN "CreatorProfile" cp ON cp."id" = cpr."creatorProfileId" AND cp."currentRevision" = cpr."revision"
         JOIN "CutEditorialPromptRevision" pr ON pr."id" = t."cutPromptRevisionId"
         JOIN "CutEditorialPrompt" p ON p."id" = pr."promptId" AND p."currentRevision" = pr."revision"
        WHERE i."id" = $1 AND i."freshUntil" >= now()
          AND t."state" = 'READY' AND ta."id" = i."transcriptArtifactId"
          AND ta."sha256" = i."transcriptSha256"
          AND s."status" = 'READY' AND s."sha256" = t."sourceSha256"
          AND j."type" = 'CUT_SEGMENT' AND j."state" = 'READY'
          AND m."status" = 'READY' AND m."sha256" = t."cutResultSha256"
          AND m."sizeBytes" = t."cutResultSizeBytes"
          AND sa."revision" = t."sourceAuthorizationRevision" AND sa."status" = 'CLEARED'
          AND sa."basis"::text = t."sourceAuthorizationBasis"
          AND (sa."basis"::text <> 'LOCAL_DEVELOPMENT_AUTO' OR $2 = 'local-auto')
          AND sa."declarationVersion" = t."sourceAuthorizationDeclarationVersion"
          AND sa."decidedAt" = t."sourceAuthorizationDecidedAt"
          AND scr."contextId" = t."sourceContextId"
          AND cpr."creatorProfileId" = t."creatorProfileId"
          AND pr."promptId" = t."cutPromptId"
          AND i."sourceContextRevisionId" = t."sourceContextRevisionId"
           AND i."creatorProfileRevisionId" = t."creatorProfileRevisionId"
           AND i."cutPromptRevisionId" = t."cutPromptRevisionId"
         FOR SHARE OF t, ta, j, m, s, sa, scr, sc, cpr, cp, pr, p`,
    [intentId, sourceAuthorizationPolicy],
  );
  return result.rows.length === 1;
}
