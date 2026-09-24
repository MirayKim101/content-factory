import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  LOCAL_TRANSCRIPT_ADAPTER_VERSION,
  TRANSCRIPT_CONTRACT_VERSION,
  type TranscriptEvidenceView,
  type TranscriptInputCapture,
  type TranscriptSegment,
} from "@content-factory/contracts";

import { apiEnvironment } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import {
  isSourceAuthorizationCleared,
  SourceAuthorizationRequiredError,
} from "../../projects/domain/source-authorization.js";
import { AiContentIdempotencyConflictError } from "../application/creator-context-repository.port.js";
import type {
  TranscriptClaim,
  TranscriptEvidenceRepository,
} from "../application/transcript-evidence-repository.port.js";
import { TranscriptContextRejectedError } from "../application/transcript-evidence-repository.port.js";
import {
  frameContextBlockers,
  type FrameContextCapture,
} from "@content-factory/contracts";
import { lockedFrameContext } from "./prisma-frame-context.js";

const LEASE_MS = 30_000;
const WORK_DEADLINE_MS = 120_000;

@Injectable()
export class PrismaTranscriptEvidenceRepository implements TranscriptEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    cutPipelineJobId: string;
    sourceContextRevisionId: string;
    cutPromptRevisionId: string;
    idempotencyKey: string;
    language: string;
    fixture: { language: string; segments: readonly TranscriptSegment[] };
  }): Promise<string> {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          TRANSCRIPT_CONTRACT_VERSION,
          "CREATE_TRANSCRIPT_EVIDENCE",
          input.cutPipelineJobId,
          input.sourceContextRevisionId,
          input.cutPromptRevisionId,
          input.language,
          input.fixture,
        ]),
      )
      .digest("hex");
    return this.serializable(async (tx) => {
      const previous = await tx.aiContentOperationRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (previous) {
        if (
          previous.operation !== "CREATE_TRANSCRIPT_EVIDENCE" ||
          previous.canonicalRequestFingerprint !== fingerprint ||
          previous.resultType !== "TRANSCRIPT_EVIDENCE"
        )
          throw new AiContentIdempotencyConflictError();
        return previous.resultId;
      }
      const facts = await lockedFrameContext(tx, input);
      const blockers = facts
        ? frameContextBlockers(
            facts,
            apiEnvironment().sourceAuthorizationPolicy,
          )
        : ["CUT_LINEAGE_UNUSABLE"];
      if (!facts || blockers.length)
        throw new TranscriptContextRejectedError(blockers);
      const capture = toStoredTranscriptCapture(facts.capture);
      const id = randomUUID();
      await tx.transcriptEvidenceIntent.create({
        data: {
          id,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          ...capture,
          cutResultSizeBytes: BigInt(capture.cutResultSizeBytes),
          contractVersion: TRANSCRIPT_CONTRACT_VERSION,
          adapterVersion: LOCAL_TRANSCRIPT_ADAPTER_VERSION,
          language: input.language,
          fixture: input.fixture as Prisma.InputJsonValue,
        },
      });
      await tx.aiContentOperationRequest.create({
        data: {
          id: randomUUID(),
          idempotencyKey: input.idempotencyKey,
          operation: "CREATE_TRANSCRIPT_EVIDENCE",
          canonicalRequestFingerprint: fingerprint,
          resolvedProjectId: capture.projectId,
          resolvedSourceId: capture.sourceId,
          resolvedSourceVersion: capture.sourceVersion,
          resultType: "TRANSCRIPT_EVIDENCE",
          resultId: id,
        },
      });
      return id;
    });
  }

  async detail(intentId: string): Promise<TranscriptEvidenceView | null> {
    const row = await this.prisma.transcriptEvidenceIntent.findUnique({
      where: { id: intentId },
      include: { artifact: true },
    });
    if (!row) return null;
    return {
      id: row.id,
      state: row.state,
      contractVersion: TRANSCRIPT_CONTRACT_VERSION,
      adapterVersion: row.adapterVersion,
      language: row.language,
      input: captureFromRow(row),
      artifact: row.artifact
        ? {
            id: row.artifact.id,
            contentType: "application/json",
            sizeBytes: Number(row.artifact.sizeBytes),
            sha256: row.artifact.sha256,
            adapterVersion: row.artifact.adapterVersion,
            language: row.artifact.language,
            segments: row.artifact.segments as unknown as TranscriptSegment[],
          }
        : null,
      failure: row.failureCode
        ? {
            code: row.failureCode,
            message: row.failureMessage ?? "Не удалось подготовить транскрипт.",
          }
        : null,
    };
  }

  async latestForJob(
    cutPipelineJobId: string,
  ): Promise<TranscriptEvidenceView | null> {
    const row = await this.prisma.transcriptEvidenceIntent.findFirst({
      where: { cutPipelineJobId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    return row ? this.detail(row.id) : null;
  }

  async content(intentId: string) {
    const row = await this.prisma.transcriptEvidenceIntent.findUnique({
      where: { id: intentId },
      include: { artifact: true },
    });
    if (!row?.artifact) return null;
    if (!(await this.sourceReadable(row)))
      throw new SourceAuthorizationRequiredError();
    return {
      objectKey: row.artifact.objectKey,
      sizeBytes: Number(row.artifact.sizeBytes),
      sha256: row.artifact.sha256,
    };
  }

  async claim(
    intentId: string,
    workerId: string,
  ): Promise<TranscriptClaim | null> {
    return this.serializable(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TranscriptEvidenceIntent" WHERE "id" = ${intentId}::uuid FOR UPDATE`;
      const row = await tx.transcriptEvidenceIntent.findUnique({
        where: { id: intentId },
        include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
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
        await tx.transcriptEvidenceAttempt.update({
          where: { id: current.id },
          data: {
            state: "FAILED_FINAL",
            finishedAt: now,
            failureCode: "TRANSCRIPT_LEASE_EXPIRED",
            failureMessage: "Предыдущий worker потерял lease.",
          },
        });
      }
      if (row.attemptCount >= row.retryBudget + 1) {
        await tx.transcriptEvidenceIntent.update({
          where: { id: row.id },
          data: {
            state: "FAILED_FINAL",
            finishedAt: now,
            failureCode: "TRANSCRIPT_RETRY_EXHAUSTED",
            failureMessage: "Исчерпан лимит попыток транскрипции.",
          },
        });
        return null;
      }
      await this.requireCurrent(tx, row);
      const attemptNumber = row.attemptCount + 1;
      const attemptId = randomUUID();
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      const workDeadlineAt = new Date(now.getTime() + WORK_DEADLINE_MS);
      await tx.transcriptEvidenceAttempt.create({
        data: {
          id: attemptId,
          intentId: row.id,
          attemptNumber,
          workerId,
          leaseToken,
          leaseExpiresAt,
          workDeadlineAt,
        },
      });
      await tx.transcriptEvidenceIntent.update({
        where: { id: row.id },
        data: {
          state: "PROCESSING",
          attemptCount: attemptNumber,
          startedAt: row.startedAt ?? now,
          failureCode: null,
          failureMessage: null,
        },
      });
      return {
        intentId: row.id,
        attemptId,
        attemptNumber,
        leaseToken,
        workDeadlineAt,
        input: captureFromRow(row),
        fixture: row.fixture as unknown as TranscriptClaim["fixture"],
      };
    });
  }

  async complete(input: {
    claim: TranscriptClaim;
    artifact: {
      id: string;
      objectKey: string;
      contentType: "application/json";
      sizeBytes: number;
      sha256: string;
      adapterVersion: string;
      language: string;
      segments: readonly TranscriptSegment[];
    };
  }): Promise<boolean> {
    return this.serializable(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TranscriptEvidenceIntent" WHERE "id" = ${input.claim.intentId}::uuid FOR UPDATE`;
      const row = await tx.transcriptEvidenceIntent.findUnique({
        where: { id: input.claim.intentId },
      });
      if (row?.state === "READY") return true;
      if (!row || row.state !== "PROCESSING") return false;
      const attempt = await tx.transcriptEvidenceAttempt.findUnique({
        where: { id: input.claim.attemptId },
      });
      const now = new Date();
      if (
        !attempt ||
        attempt.leaseToken !== input.claim.leaseToken ||
        attempt.state !== "PROCESSING" ||
        attempt.workDeadlineAt < now ||
        attempt.leaseExpiresAt < now
      )
        return false;
      await this.requireCurrent(tx, row);
      await tx.transcriptEvidenceArtifact.create({
        data: {
          ...input.artifact,
          sizeBytes: BigInt(input.artifact.sizeBytes),
          segments: [...input.artifact.segments] as Prisma.InputJsonValue,
          intentId: row.id,
        },
      });
      await tx.transcriptEvidenceAttempt.update({
        where: { id: attempt.id },
        data: { state: "READY", finishedAt: now },
      });
      await tx.transcriptEvidenceIntent.update({
        where: { id: row.id },
        data: { state: "READY", finishedAt: now },
      });
      return true;
    });
  }

  async fail(input: {
    claim: TranscriptClaim;
    code: string;
    message: string;
    retryable: boolean;
  }): Promise<void> {
    await this.serializable(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TranscriptEvidenceIntent" WHERE "id" = ${input.claim.intentId}::uuid FOR UPDATE`;
      const attempt = await tx.transcriptEvidenceAttempt.findUnique({
        where: { id: input.claim.attemptId },
      });
      if (!attempt || attempt.leaseToken !== input.claim.leaseToken) return;
      const row = await tx.transcriptEvidenceIntent.findUnique({
        where: { id: input.claim.intentId },
      });
      if (!row || row.state !== "PROCESSING" || attempt.state !== "PROCESSING")
        return;
      const now = new Date();
      await tx.transcriptEvidenceAttempt.update({
        where: { id: attempt.id },
        data: {
          state: "FAILED_FINAL",
          finishedAt: now,
          failureCode: input.code,
          failureMessage: input.message,
        },
      });
      const retry = input.retryable && row.attemptCount <= row.retryBudget;
      await tx.transcriptEvidenceIntent.update({
        where: { id: row.id },
        data: {
          state: retry ? "QUEUED" : "FAILED_FINAL",
          queuedAt: retry ? now : row.queuedAt,
          finishedAt: retry ? null : now,
          failureCode: retry ? null : input.code,
          failureMessage: retry ? null : input.message,
        },
      });
    });
  }

  private async requireCurrent(
    tx: Prisma.TransactionClient,
    row: {
      cutPipelineJobId: string;
      sourceContextRevisionId: string;
      cutPromptRevisionId: string;
      projectId: string;
      sourceId: string;
      sourceVersion: number;
      sourceSha256: string;
      sourceAuthorizationRevision: number;
      sourceAuthorizationBasis: string | null;
      sourceAuthorizationDeclarationVersion: string | null;
      sourceAuthorizationDecidedAt: Date | null;
      cutResultArtifactId: string;
      cutResultSha256: string;
      cutResultSizeBytes: bigint;
      cutStartMs: number;
      cutEndMs: number;
      creatorProfileRevisionId: string;
      creatorProfileId: string | null;
      creatorProfileRevisionNo: number;
      sourceContextRevisionNo: number;
      sourceContextId: string | null;
      cutPromptRevisionNo: number;
      cutPromptId: string | null;
    },
  ): Promise<void> {
    const facts = await lockedFrameContext(tx, row);
    const captured = policyCaptureFromRow(row);
    const blockers = facts
      ? captured
        ? frameContextBlockers(
            facts,
            apiEnvironment().sourceAuthorizationPolicy,
            captured,
          )
        : ["CAPTURED_CONTEXT_CHANGED" as const]
      : ["CUT_LINEAGE_UNUSABLE"];
    if (blockers.length) throw new TranscriptContextRejectedError(blockers);
  }

  private async sourceReadable(row: {
    sourceId: string;
    sourceVersion: number;
  }): Promise<boolean> {
    const source = await this.prisma.videoSource.findFirst({
      where: {
        id: row.sourceId,
        sourceVersion: row.sourceVersion,
        status: "READY",
      },
      include: { authorizations: true },
    });
    const authorization = source?.authorizations.find(
      (item) => item.sourceVersion === row.sourceVersion,
    );
    return Boolean(
      source &&
      isSourceAuthorizationCleared(
        authorization
          ? {
              ...authorization,
              basis: authorization.basis ?? undefined,
              declarationVersion: authorization.declarationVersion ?? undefined,
              decidedAt: authorization.decidedAt ?? undefined,
            }
          : null,
        row.sourceVersion,
        apiEnvironment().sourceAuthorizationPolicy,
      ),
    );
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
        const code = (error as { code?: string }).code;
        if (attempt < 2 && (code === "40001" || code === "40P01")) continue;
        throw error;
      }
    }
  }
}

type StoredTranscriptCapture = TranscriptInputCapture &
  Pick<
    FrameContextCapture,
    | "sourceAuthorizationBasis"
    | "sourceAuthorizationDeclarationVersion"
    | "sourceAuthorizationDecidedAt"
    | "creatorProfileId"
    | "sourceContextId"
    | "cutPromptId"
  >;

function toStoredTranscriptCapture(
  capture: FrameContextCapture,
): StoredTranscriptCapture {
  return {
    projectId: capture.projectId,
    sourceId: capture.sourceId,
    sourceVersion: capture.sourceVersion,
    sourceSha256: capture.sourceSha256,
    sourceAuthorizationRevision: capture.sourceAuthorizationRevision,
    sourceAuthorizationBasis: capture.sourceAuthorizationBasis,
    sourceAuthorizationDeclarationVersion:
      capture.sourceAuthorizationDeclarationVersion,
    sourceAuthorizationDecidedAt: capture.sourceAuthorizationDecidedAt,
    cutPipelineJobId: capture.cutPipelineJobId,
    cutResultArtifactId: capture.cutResultArtifactId,
    cutResultSha256: capture.cutResultSha256,
    cutResultSizeBytes: capture.cutResultSizeBytes,
    cutStartMs: capture.cutStartMs,
    cutEndMs: capture.cutEndMs,
    creatorProfileRevisionId: capture.creatorProfileRevisionId,
    creatorProfileId: capture.creatorProfileId,
    creatorProfileRevisionNo: capture.creatorProfileRevisionNo,
    sourceContextRevisionId: capture.sourceContextRevisionId,
    sourceContextId: capture.sourceContextId,
    sourceContextRevisionNo: capture.sourceContextRevisionNo,
    cutPromptRevisionId: capture.cutPromptRevisionId,
    cutPromptId: capture.cutPromptId,
    cutPromptRevisionNo: capture.cutPromptRevisionNo,
  };
}

function policyCaptureFromRow(row: {
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
  creatorProfileId: string | null;
  creatorProfileRevisionId: string;
  creatorProfileRevisionNo: number;
  sourceContextId: string | null;
  sourceContextRevisionId: string;
  sourceContextRevisionNo: number;
  cutPromptId: string | null;
  cutPromptRevisionId: string;
  cutPromptRevisionNo: number;
}): FrameContextCapture | null {
  if (
    !row.sourceAuthorizationBasis ||
    !row.sourceAuthorizationDeclarationVersion ||
    !row.sourceAuthorizationDecidedAt ||
    !row.creatorProfileId ||
    !row.sourceContextId ||
    !row.cutPromptId
  )
    return null;
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

function captureFromRow(row: {
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceSha256: string;
  sourceAuthorizationRevision: number;
  cutPipelineJobId: string;
  cutResultArtifactId: string;
  cutResultSha256: string;
  cutResultSizeBytes: bigint;
  cutStartMs: number;
  cutEndMs: number;
  creatorProfileRevisionId: string;
  creatorProfileRevisionNo: number;
  sourceContextRevisionId: string;
  sourceContextRevisionNo: number;
  cutPromptRevisionId: string;
  cutPromptRevisionNo: number;
}): TranscriptInputCapture {
  return {
    ...row,
    cutResultSizeBytes: row.cutResultSizeBytes.toString(),
  };
}
