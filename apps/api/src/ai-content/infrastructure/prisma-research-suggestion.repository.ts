import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import {
  LOCAL_RESEARCH_ADAPTER_VERSION,
  LOCAL_RESEARCH_COST_BASIS_VERSION,
  RESEARCH_CONTRACT_VERSION,
  RESEARCH_FRESHNESS_POLICY_VERSION,
  frameContextBlockers,
  type FrameContextCapture,
  type ResearchCitation,
  type ResearchSuggestionView,
  type TextSuggestion,
} from "@content-factory/contracts";

import { apiEnvironment } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AiContentIdempotencyConflictError } from "../application/creator-context-repository.port.js";
import type {
  ResearchCitationInput,
  ResearchSuggestionClaim,
  ResearchSuggestionRepository,
} from "../application/research-suggestion-repository.port.js";
import { ResearchSuggestionContextRejectedError } from "../application/research-suggestion-repository.port.js";
import { normalizePublicCitationUrl } from "../research/public-citation-url.js";
import { lockedFrameContext } from "./prisma-frame-context.js";

const FRESHNESS_MS = 24 * 60 * 60 * 1_000;
const LEASE_MS = 30_000;
const WORK_DEADLINE_MS = 120_000;

const intentInclude = {
  citations: { orderBy: { ordinal: "asc" as const } },
  suggestionSet: true,
} satisfies Prisma.ResearchSuggestionIntentInclude;

type IntentRow = Prisma.ResearchSuggestionIntentGetPayload<{
  include: typeof intentInclude;
}>;

@Injectable()
export class PrismaResearchSuggestionRepository implements ResearchSuggestionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    transcriptIntentId: string;
    idempotencyKey: string;
    query: string;
    citations: readonly ResearchCitationInput[];
  }): Promise<string> {
    const query = input.query.trim();
    if (!query || query.length > 4_000)
      throw new ResearchSuggestionContextRejectedError(
        "RESEARCH_QUERY_INVALID",
      );
    if (input.citations.length < 1 || input.citations.length > 20)
      throw new ResearchSuggestionContextRejectedError(
        "RESEARCH_CITATIONS_INVALID",
      );
    const accessedAt = new Date();
    const citations = input.citations.map((citation, ordinal) =>
      normalizeCitation(citation, ordinal, accessedAt),
    );
    if (
      new Set(citations.map((citation) => citation.url)).size !==
      citations.length
    )
      throw new ResearchSuggestionContextRejectedError(
        "RESEARCH_CITATION_DUPLICATE",
      );

    return this.serializable(async (tx) => {
      const transcript = await tx.transcriptEvidenceIntent.findUnique({
        where: { id: input.transcriptIntentId },
        include: { artifact: true },
      });
      if (
        !transcript ||
        transcript.state !== "READY" ||
        !transcript.artifact ||
        !isSha256(transcript.artifact.sha256)
      ) {
        throw new ResearchSuggestionContextRejectedError(
          "RESEARCH_TRANSCRIPT_NOT_READY",
        );
      }
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            RESEARCH_CONTRACT_VERSION,
            "CREATE_RESEARCH_SUGGESTION",
            input.transcriptIntentId,
            transcript.artifact.id,
            transcript.artifact.sha256,
            query,
            citations.map(
              ({ id: _id, accessedAt: _accessedAt, ...citation }) => citation,
            ),
          ]),
        )
        .digest("hex");
      const previous = await tx.aiContentOperationRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (previous) {
        if (
          previous.operation !== "CREATE_RESEARCH_SUGGESTION" ||
          previous.canonicalRequestFingerprint !== fingerprint ||
          previous.resultType !== "RESEARCH_SUGGESTION"
        ) {
          throw new AiContentIdempotencyConflictError();
        }
        return previous.resultId;
      }
      await this.requireCurrent(tx, transcript);

      const id = randomUUID();
      const freshUntil = new Date(accessedAt.getTime() + FRESHNESS_MS);
      const contextPolicyFingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            transcript.sourceAuthorizationRevision,
            transcript.creatorProfileRevisionId,
            transcript.sourceContextRevisionId,
            transcript.cutPromptRevisionId,
          ]),
        )
        .digest("hex");
      await tx.researchSuggestionIntent.create({
        data: {
          id,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          transcriptIntentId: transcript.id,
          projectId: transcript.projectId,
          sourceId: transcript.sourceId,
          sourceVersion: transcript.sourceVersion,
          cutPipelineJobId: transcript.cutPipelineJobId,
          cutResultArtifactId: transcript.cutResultArtifactId,
          creatorProfileRevisionId: transcript.creatorProfileRevisionId,
          sourceContextRevisionId: transcript.sourceContextRevisionId,
          cutPromptRevisionId: transcript.cutPromptRevisionId,
          contextPolicyFingerprint,
          transcriptArtifactId: transcript.artifact.id,
          transcriptSha256: transcript.artifact.sha256,
          query,
          contractVersion: RESEARCH_CONTRACT_VERSION,
          adapterVersion: LOCAL_RESEARCH_ADAPTER_VERSION,
          freshnessPolicyVersion: RESEARCH_FRESHNESS_POLICY_VERSION,
          searchedAt: accessedAt,
          freshUntil,
          citations: {
            create: citations,
          },
        },
      });
      await tx.aiContentOperationRequest.create({
        data: {
          id: randomUUID(),
          idempotencyKey: input.idempotencyKey,
          operation: "CREATE_RESEARCH_SUGGESTION",
          canonicalRequestFingerprint: fingerprint,
          resolvedProjectId: transcript.projectId,
          resolvedSourceId: transcript.sourceId,
          resolvedSourceVersion: transcript.sourceVersion,
          resultType: "RESEARCH_SUGGESTION",
          resultId: id,
        },
      });
      return id;
    });
  }

  async detail(intentId: string): Promise<ResearchSuggestionView | null> {
    const row = await this.prisma.researchSuggestionIntent.findUnique({
      where: { id: intentId },
      include: intentInclude,
    });
    return row ? this.map(row) : null;
  }

  async list(transcriptIntentId: string): Promise<ResearchSuggestionView[]> {
    const rows = await this.prisma.researchSuggestionIntent.findMany({
      where: { transcriptIntentId },
      include: intentInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    });
    return rows.map((row) => this.map(row));
  }

  async resolveForApply(intentId: string) {
    return this.serializable(async (tx) => {
      const row = await tx.researchSuggestionIntent.findUnique({
        where: { id: intentId },
        include: { suggestionSet: true },
      });
      if (!row || row.state !== "READY" || !row.suggestionSet)
        throw new ResearchSuggestionContextRejectedError(
          "RESEARCH_SUGGESTION_NOT_READY",
        );
      if (row.freshUntil < new Date())
        throw new ResearchSuggestionContextRejectedError(
          "RESEARCH_SNAPSHOT_EXPIRED",
        );
      const transcript = await this.requireCapturedTranscript(tx, row);
      await this.requireCurrent(tx, transcript);
      return {
        pipelineJobId: row.cutPipelineJobId,
        researchIntentId: row.id,
        suggestionSetId: row.suggestionSet.id,
        suggestion: {
          id: row.suggestionSet.id,
          title: row.suggestionSet.title,
          description: row.suggestionSet.description,
          tags: stringArray(row.suggestionSet.tags),
          basisVersion: row.suggestionSet.basisVersion,
          citationIds: stringArray(row.suggestionSet.citationIds),
          claims: claimsArray(row.suggestionSet.claims),
        },
      };
    });
  }

  async claim(intentId: string): Promise<ResearchSuggestionClaim | null> {
    return this.serializable(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ResearchSuggestionIntent" WHERE "id" = ${intentId}::uuid FOR UPDATE`;
      const row = await tx.researchSuggestionIntent.findUnique({
        where: { id: intentId },
        include: {
          citations: { orderBy: { ordinal: "asc" } },
          attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
        },
      });
      if (!row || row.state === "READY" || row.state === "FAILED_FINAL")
        return null;
      const now = new Date();
      const current = row.attempts[0];
      if (
        row.state === "PROCESSING" &&
        current?.state === "PROCESSING" &&
        current.leaseExpiresAt > now
      )
        return null;
      if (current?.state === "PROCESSING") {
        await tx.researchSuggestionAttempt.update({
          where: { id: current.id },
          data: {
            state: "FAILED_FINAL",
            failureCode: "RESEARCH_LEASE_EXPIRED",
            failureMessage: "Предыдущий AI worker потерял lease.",
          },
        });
      }
      const attemptCount = await tx.researchSuggestionAttempt.count({
        where: { intentId: row.id },
      });
      if (attemptCount >= 2) {
        await tx.researchSuggestionIntent.update({
          where: { id: row.id },
          data: {
            state: "FAILED_FINAL",
            failureCode: "RESEARCH_RETRY_EXHAUSTED",
            failureMessage: "Исчерпан лимит попыток подготовки метаданных.",
          },
        });
        return null;
      }
      const transcript = await this.requireCapturedTranscript(tx, row);
      await this.requireCurrent(tx, transcript);
      const sourceContext = await tx.sourceEditorialContextRevision.findUnique({
        where: { id: row.sourceContextRevisionId },
        select: { sourceTitle: true },
      });
      if (!sourceContext)
        throw new ResearchSuggestionContextRejectedError(
          "RESEARCH_CONTEXT_STALE",
        );
      const attemptNumber = (current?.attemptNumber ?? 0) + 1;
      const attemptId = randomUUID();
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      const workDeadlineAt = new Date(now.getTime() + WORK_DEADLINE_MS);
      await tx.researchSuggestionAttempt.create({
        data: {
          id: attemptId,
          intentId: row.id,
          attemptNumber,
          leaseToken,
          leaseExpiresAt,
          workDeadlineAt,
        },
      });
      await tx.researchSuggestionIntent.update({
        where: { id: row.id },
        data: { state: "PROCESSING", failureCode: null, failureMessage: null },
      });
      return {
        intentId: row.id,
        attemptId,
        leaseToken,
        workDeadlineAt,
        sourceTitle: sourceContext.sourceTitle,
        snapshot: snapshotFromRow(row),
      };
    });
  }

  async complete(input: {
    claim: ResearchSuggestionClaim;
    suggestion: TextSuggestion;
  }): Promise<boolean> {
    return this.serializable(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ResearchSuggestionIntent" WHERE "id" = ${input.claim.intentId}::uuid FOR UPDATE`;
      const row = await tx.researchSuggestionIntent.findUnique({
        where: { id: input.claim.intentId },
      });
      if (row?.state === "READY") return true;
      if (!row || row.state !== "PROCESSING") return false;
      const attempt = await tx.researchSuggestionAttempt.findUnique({
        where: { id: input.claim.attemptId },
      });
      const now = new Date();
      if (
        !attempt ||
        attempt.state !== "PROCESSING" ||
        attempt.leaseToken !== input.claim.leaseToken ||
        attempt.leaseExpiresAt < now ||
        attempt.workDeadlineAt < now
      )
        return false;
      const transcript = await this.requireCapturedTranscript(tx, row);
      await this.requireCurrent(tx, transcript);
      if (row.freshUntil < now)
        throw new ResearchSuggestionContextRejectedError(
          "RESEARCH_SNAPSHOT_EXPIRED",
        );
      const citationIds = row
        ? await tx.researchCitation.findMany({
            where: { intentId: row.id },
            select: { id: true },
          })
        : [];
      const allowed = new Set(citationIds.map((item) => item.id));
      if (input.suggestion.citationIds.some((id) => !allowed.has(id)))
        throw new ResearchSuggestionContextRejectedError(
          "RESEARCH_CITATION_LINEAGE_INVALID",
        );
      await tx.researchSuggestionSet.create({
        data: {
          id: input.suggestion.id,
          intentId: row.id,
          attemptId: attempt.id,
          title: input.suggestion.title,
          description: input.suggestion.description,
          tags: [...input.suggestion.tags] as Prisma.InputJsonValue,
          claims: [...input.suggestion.claims] as Prisma.InputJsonValue,
          citationIds: [
            ...input.suggestion.citationIds,
          ] as Prisma.InputJsonValue,
          basisVersion: input.suggestion.basisVersion,
          directCostMicrousd: 0n,
          costBasisVersion: LOCAL_RESEARCH_COST_BASIS_VERSION,
        },
      });
      await tx.researchSuggestionAttempt.update({
        where: { id: attempt.id },
        data: { state: "READY" },
      });
      await tx.researchSuggestionIntent.update({
        where: { id: row.id },
        data: { state: "READY" },
      });
      return true;
    });
  }

  async fail(input: {
    claim: ResearchSuggestionClaim;
    code: string;
    message: string;
  }): Promise<void> {
    await this.serializable(async (tx) => {
      const attempt = await tx.researchSuggestionAttempt.findUnique({
        where: { id: input.claim.attemptId },
      });
      if (
        !attempt ||
        attempt.leaseToken !== input.claim.leaseToken ||
        attempt.state !== "PROCESSING"
      )
        return;
      await tx.researchSuggestionAttempt.update({
        where: { id: attempt.id },
        data: {
          state: "FAILED_FINAL",
          failureCode: input.code,
          failureMessage: input.message,
        },
      });
      await tx.researchSuggestionIntent.updateMany({
        where: { id: input.claim.intentId, state: "PROCESSING" },
        data: {
          state: "FAILED_FINAL",
          failureCode: input.code,
          failureMessage: input.message,
        },
      });
    });
  }

  private async requireCapturedTranscript(
    tx: Prisma.TransactionClient,
    row: {
      transcriptIntentId: string;
      transcriptArtifactId: string;
      transcriptSha256: string;
    },
  ) {
    const transcript = await tx.transcriptEvidenceIntent.findUnique({
      where: { id: row.transcriptIntentId },
      include: { artifact: true },
    });
    if (
      !transcript ||
      transcript.state !== "READY" ||
      transcript.artifact?.id !== row.transcriptArtifactId ||
      transcript.artifact.sha256 !== row.transcriptSha256
    )
      throw new ResearchSuggestionContextRejectedError(
        "RESEARCH_TRANSCRIPT_STALE",
      );
    return transcript;
  }

  private async requireCurrent(
    tx: Prisma.TransactionClient,
    transcript: Parameters<typeof transcriptCapture>[0],
  ): Promise<void> {
    const facts = await lockedFrameContext(tx, transcript);
    const blockers = facts
      ? frameContextBlockers(
          facts,
          apiEnvironment().sourceAuthorizationPolicy,
          transcriptCapture(transcript),
        )
      : ["CUT_LINEAGE_UNUSABLE"];
    if (blockers.length)
      throw new ResearchSuggestionContextRejectedError(
        "RESEARCH_CONTEXT_STALE",
      );
  }

  private map(row: IntentRow): ResearchSuggestionView {
    const suggestion = row.suggestionSet
      ? {
          id: row.suggestionSet.id,
          title: row.suggestionSet.title,
          description: row.suggestionSet.description,
          tags: stringArray(row.suggestionSet.tags),
          basisVersion: row.suggestionSet.basisVersion,
          citationIds: stringArray(row.suggestionSet.citationIds),
          claims: claimsArray(row.suggestionSet.claims),
        }
      : null;
    return {
      id: row.id,
      transcriptIntentId: row.transcriptIntentId,
      state: row.state,
      snapshot: snapshotFromRow(row),
      suggestion,
      cost: row.suggestionSet
        ? {
            directCostMicrousd: row.suggestionSet.directCostMicrousd.toString(),
            basisVersion: row.suggestionSet.costBasisVersion,
          }
        : null,
      failure: row.failureCode
        ? {
            code: row.failureCode,
            message:
              row.failureMessage ?? "Не удалось подготовить варианты текста.",
          }
        : null,
    };
  }

  private async serializable<T>(
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(action, {
          isolationLevel: "Serializable",
        });
      } catch (error) {
        const failure = error as {
          code?: string;
          meta?: {
            code?: string;
            driverAdapterError?: { cause?: { originalCode?: string } };
          };
        };
        const rawCode =
          failure.meta?.code ??
          failure.meta?.driverAdapterError?.cause?.originalCode;
        const retryable =
          failure.code === "P2034" ||
          failure.code === "P2002" ||
          (failure.code === "P2010" &&
            (rawCode === "40001" || rawCode === "40P01"));
        if (attempt < 4 && retryable) continue;
        throw error;
      }
    }
  }
}

function normalizeCitation(
  input: ResearchCitationInput,
  ordinal: number,
  accessedAt: Date,
) {
  const url = normalizePublicCitationUrl(input.url);
  if (!url)
    throw new ResearchSuggestionContextRejectedError(
      "RESEARCH_CITATION_INVALID",
    );
  const title = input.title.trim();
  const publisher = input.publisher.trim();
  const excerpt = input.excerpt.trim();
  if (!title || !publisher || !excerpt)
    throw new ResearchSuggestionContextRejectedError(
      "RESEARCH_CITATION_INVALID",
    );
  const publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  if (publishedAt && Number.isNaN(publishedAt.getTime()))
    throw new ResearchSuggestionContextRejectedError(
      "RESEARCH_CITATION_INVALID",
    );
  return {
    id: randomUUID(),
    ordinal,
    url,
    title: title.slice(0, 500),
    publisher: publisher.slice(0, 300),
    publishedAt,
    accessedAt,
    excerpt: excerpt.slice(0, 4_000),
    checksum: createHash("sha256").update(excerpt).digest("hex"),
  };
}

function snapshotFromRow(row: {
  contractVersion: string;
  adapterVersion: string;
  query: string;
  searchedAt: Date;
  freshUntil: Date;
  freshnessPolicyVersion: string;
  citations: Array<{
    id: string;
    url: string;
    title: string;
    publisher: string;
    publishedAt: Date | null;
    accessedAt: Date;
    excerpt: string;
    checksum: string;
  }>;
}): ResearchSuggestionView["snapshot"] {
  if (row.contractVersion !== RESEARCH_CONTRACT_VERSION)
    throw new ResearchSuggestionContextRejectedError(
      "RESEARCH_CONTRACT_INVALID",
    );
  return {
    contractVersion: RESEARCH_CONTRACT_VERSION,
    adapterVersion: row.adapterVersion,
    query: row.query,
    freshness: row.freshUntil >= new Date() ? "CURRENT" : "STALE",
    searchedAt: row.searchedAt.toISOString(),
    freshUntil: row.freshUntil.toISOString(),
    freshnessPolicyVersion: row.freshnessPolicyVersion,
    citations: row.citations.map((citation): ResearchCitation => ({
      id: citation.id,
      url: citation.url,
      title: citation.title,
      publisher: citation.publisher,
      publishedAt: citation.publishedAt?.toISOString() ?? null,
      accessedAt: citation.accessedAt.toISOString(),
      excerpt: citation.excerpt,
      checksum: citation.checksum,
    })),
  };
}

function transcriptCapture(row: {
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceSha256: string;
  sourceAuthorizationRevision: number;
  sourceAuthorizationBasis: string | null;
  sourceAuthorizationDeclarationVersion: string | null;
  sourceAuthorizationDecidedAt: Date | null;
  cutPipelineJobId: string;
  cutResultArtifactId: string;
  cutResultSha256: string;
  cutResultSizeBytes: bigint;
  cutStartMs: number;
  cutEndMs: number;
  creatorProfileRevisionId: string;
  creatorProfileId: string | null;
  creatorProfileRevisionNo: number;
  sourceContextRevisionId: string;
  sourceContextId: string | null;
  sourceContextRevisionNo: number;
  cutPromptRevisionId: string;
  cutPromptId: string | null;
  cutPromptRevisionNo: number;
}): FrameContextCapture {
  if (
    !row.sourceAuthorizationBasis ||
    !row.sourceAuthorizationDeclarationVersion ||
    !row.sourceAuthorizationDecidedAt ||
    !row.creatorProfileId ||
    !row.sourceContextId ||
    !row.cutPromptId
  )
    throw new ResearchSuggestionContextRejectedError("RESEARCH_CONTEXT_STALE");
  return {
    ...row,
    sourceAuthorizationBasis: row.sourceAuthorizationBasis,
    sourceAuthorizationDeclarationVersion:
      row.sourceAuthorizationDeclarationVersion,
    sourceAuthorizationDecidedAt:
      row.sourceAuthorizationDecidedAt.toISOString(),
    creatorProfileId: row.creatorProfileId,
    sourceContextId: row.sourceContextId,
    cutPromptId: row.cutPromptId,
    cutResultSizeBytes: row.cutResultSizeBytes.toString(),
  };
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new ResearchSuggestionContextRejectedError("RESEARCH_RESULT_INVALID");
  return value;
}

function claimsArray(
  value: unknown,
): Array<{ text: string; citationIds: string[] }> {
  if (!Array.isArray(value))
    throw new ResearchSuggestionContextRejectedError("RESEARCH_RESULT_INVALID");
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("text" in item) ||
      typeof item.text !== "string" ||
      !("citationIds" in item)
    )
      throw new ResearchSuggestionContextRejectedError(
        "RESEARCH_RESULT_INVALID",
      );
    return { text: item.text, citationIds: stringArray(item.citationIds) };
  });
}
