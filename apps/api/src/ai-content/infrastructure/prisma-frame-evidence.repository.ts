import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  FRAME_EVIDENCE_CONTRACT,
  FRAME_EXTRACTION_RECIPE,
  FRAME_PROGRESS_SCHEMA,
  frameContextBlockers,
  frameRequestedPositions,
  validateFrameMeasurements,
  type FrameContextCapture,
  type FrameMeasurement,
} from "@content-factory/contracts";

import { PrismaService } from "../../database/prisma.service.js";
import type {
  FrameEvidenceIntent,
  Prisma,
  SourceAuthorizationBasis,
} from "../../generated/prisma/client.js";
import { apiEnvironment } from "../../config/environment.js";
import {
  isSourceAuthorizationCleared,
  SourceAuthorizationRequiredError,
} from "../../projects/domain/source-authorization.js";
import { AiContentIdempotencyConflictError } from "../application/creator-context-repository.port.js";
import type {
  FrameEvidenceRepository,
  FrameEvidenceView,
} from "../application/frame-evidence-repository.port.js";
import {
  decodeScopedCursor,
  encodeScopedCursor,
} from "../domain/creator-context.js";
import {
  frameContextFingerprint,
  lockedFrameContext,
  requireFrameContext,
} from "./prisma-frame-context.js";

@Injectable()
export class PrismaFrameEvidenceRepository implements FrameEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    cutPipelineJobId: string;
    sourceContextRevisionId: string;
    cutPromptRevisionId: string;
    idempotencyKey: string;
  }): Promise<string> {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          FRAME_EVIDENCE_CONTRACT,
          "CREATE_FRAME_EVIDENCE",
          input.cutPipelineJobId,
          input.sourceContextRevisionId,
          input.cutPromptRevisionId,
        ]),
      )
      .digest("hex");
    return this.serializable(async (tx) => {
      const previous = await tx.aiContentOperationRequest.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (previous) {
        if (
          previous.operation !== "CREATE_FRAME_EVIDENCE" ||
          previous.canonicalRequestFingerprint !== fingerprint ||
          previous.resultType !== "FRAME_EVIDENCE"
        )
          throw new AiContentIdempotencyConflictError();
        return previous.resultId;
      }
      const facts = requireFrameContext(
        await lockedFrameContext(tx, input),
        apiEnvironment().sourceAuthorizationPolicy,
      );
      const capture = facts.capture;
      const positions = frameRequestedPositions(
        capture.cutStartMs,
        capture.cutEndMs,
        Number(capture.cutResultSizeBytes),
      );
      const id = randomUUID();
      const pipelineJobId = randomUUID();
      await tx.pipelineJob.create({
        data: {
          id: pipelineJobId,
          projectId: capture.projectId,
          sourceId: capture.sourceId,
          sourceVersion: capture.sourceVersion,
          type: "EXTRACT_EDITORIAL_FRAMES",
          state: "QUEUED",
          recipeVersion: FRAME_EXTRACTION_RECIPE,
          idempotencyKey: `frame-evidence:${id}`,
          totalMs: capture.cutEndMs - capture.cutStartMs,
        },
      });
      await tx.frameEvidenceIntent.create({
        data: {
          ...capture,
          id,
          pipelineJobId,
          sourceAuthorizationBasis:
            capture.sourceAuthorizationBasis as SourceAuthorizationBasis,
          sourceAuthorizationDecidedAt: new Date(
            capture.sourceAuthorizationDecidedAt,
          ),
          cutResultSizeBytes: BigInt(capture.cutResultSizeBytes),
          contractDurationMs: capture.cutEndMs - capture.cutStartMs,
          contextPolicyFingerprint: frameContextFingerprint(capture),
          contractVersion: FRAME_EVIDENCE_CONTRACT,
          recipeVersion: FRAME_EXTRACTION_RECIPE,
          requestedPositionsMs: [...positions],
        },
      });
      await tx.aiContentOperationRequest.create({
        data: {
          id: randomUUID(),
          idempotencyKey: input.idempotencyKey,
          operation: "CREATE_FRAME_EVIDENCE",
          canonicalRequestFingerprint: fingerprint,
          resolvedProjectId: capture.projectId,
          resolvedSourceId: capture.sourceId,
          resolvedSourceVersion: capture.sourceVersion,
          creatorProfileId: capture.creatorProfileId,
          resultType: "FRAME_EVIDENCE",
          resultId: id,
        },
      });
      return id;
    });
  }

  async detail(intentId: string): Promise<FrameEvidenceView | null> {
    return this.serializable(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "FrameEvidenceIntent" WHERE "id" = ${intentId}::uuid FOR UPDATE`;
      const intent = await tx.frameEvidenceIntent.findUnique({
        where: { id: intentId },
        include: {
          pipelineJob: true,
          attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
          result: {
            include: {
              frames: {
                orderBy: { ordinal: "asc" },
                include: { output: true },
              },
            },
          },
        },
      });
      if (!intent) return null;
      const captured = intentCapture(intent);
      const facts = await lockedFrameContext(tx, intent);
      const blockers = facts
        ? frameContextBlockers(
            facts,
            apiEnvironment().sourceAuthorizationPolicy,
            captured,
          )
        : ["CUT_LINEAGE_UNUSABLE"];
      const bytesReadable = await this.sourceReadable(tx, intent);
      const attempt = intent.attempts[0];
      const job = intent.pipelineJob;
      const complete = completeFrameResult(intent, intent.result);
      const invalidReady = job.state === "READY" && !complete;
      if (invalidReady) blockers.push("FRAME_RESULT_INCOMPLETE");
      return {
        id: intent.id,
        pipelineJobId: job.id,
        identity: captured,
        contractVersion: intent.contractVersion,
        recipeVersion: intent.recipeVersion,
        requestedPositionsMs: intent.requestedPositionsMs as number[],
        createdAt: intent.createdAt,
        currentUse: {
          usableForGeneration: job.state === "READY" && blockers.length === 0,
          blockers,
          contextPolicyFingerprint: facts
            ? frameContextFingerprint(facts.capture)
            : null,
        },
        contentAccess: {
          bytesReadable,
          blocker: bytesReadable ? null : "SOURCE_AUTHORIZATION_REQUIRED",
        },
        job: {
          state: invalidReady ? "FAILED_FINAL" : job.state,
          revision: job.revision,
          attempt: job.attemptCount,
          nextAttemptAt: job.nextAttemptAt,
          admissionReason: job.admissionReason,
          failure: invalidReady
            ? {
                code: "FRAME_RESULT_INCOMPLETE",
                message:
                  "Сохранённый набор кадров не прошёл проверку целостности.",
              }
            : job.failureCode
              ? {
                  code: job.failureCode,
                  message:
                    job.failureMessage ?? "Не удалось подготовить кадры.",
                }
              : null,
          progress: attempt
            ? {
                schemaVersion: FRAME_PROGRESS_SCHEMA,
                phase: attempt.progressPhase,
                completedFrameCount: attempt.completedFrameCount,
                basisPoints: attempt.progressBasisPoints,
              }
            : null,
        },
        frames:
          job.state === "READY" && complete
            ? (intent.result?.frames ?? []).map((frame) => ({
                id: frame.id,
                measurement: frame.measurement as unknown as FrameMeasurement,
              }))
            : [],
      };
    });
  }

  async list(
    cutPipelineJobId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: FrameEvidenceView[]; nextCursor: string | null }> {
    const cut = await this.prisma.pipelineJob.findUnique({
      where: { id: cutPipelineJobId },
      select: { projectId: true, type: true },
    });
    if (!cut || cut.type !== "CUT_SEGMENT")
      return { items: [], nextCursor: null };
    const scope = `frames:${cut.projectId}:${cutPipelineJobId}`;
    const after = cursor ? decodeScopedCursor(cursor, scope) : null;
    const rows = await this.prisma.frameEvidenceIntent.findMany({
      where: {
        cutPipelineJobId,
        projectId: cut.projectId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const selected = rows.slice(0, limit);
    const items: FrameEvidenceView[] = [];
    for (const row of selected) {
      const view = await this.detail(row.id);
      if (view) items.push(view);
    }
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeScopedCursor({
              scope,
              createdAt: last.createdAt,
              id: last.id,
            })
          : null,
    };
  }

  async content(
    intentId: string,
    frameId: string,
  ): Promise<{ objectKey: string; measurement: FrameMeasurement } | null> {
    return this.serializable(async (tx) => {
      const frame = await tx.frameEvidenceFrame.findFirst({
        where: { id: frameId, intentId },
        include: {
          output: true,
          result: {
            include: {
              frames: {
                orderBy: { ordinal: "asc" },
                include: { output: true },
              },
              intent: { include: { pipelineJob: true } },
            },
          },
        },
      });
      if (
        !frame ||
        frame.result.intent.pipelineJob.state !== "READY" ||
        frame.output.state !== "ACCEPTED" ||
        frame.output.intentId !== intentId ||
        frame.output.attemptId !== frame.result.attemptId
      )
        return null;
      const intent = frame.result.intent;
      if (!completeFrameResult(intent, frame.result)) return null;
      await tx.$queryRaw`SELECT "id" FROM "VideoSource" WHERE "id" = ${intent.sourceId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT "sourceId" FROM "SourceAuthorization" WHERE "sourceId" = ${intent.sourceId} AND "sourceVersion" = ${intent.sourceVersion} FOR SHARE`;
      if (!(await this.sourceReadable(tx, intent)))
        throw new SourceAuthorizationRequiredError();
      return {
        objectKey: frame.output.objectKey,
        measurement: frame.measurement as unknown as FrameMeasurement,
      };
    });
  }

  private async sourceReadable(
    tx: Prisma.TransactionClient,
    intent: FrameEvidenceIntent,
  ): Promise<boolean> {
    const source = await tx.videoSource.findFirst({
      where: {
        id: intent.sourceId,
        projectId: intent.projectId,
        sourceVersion: intent.sourceVersion,
        status: "READY",
      },
      include: { authorizations: true },
    });
    const auth = source?.authorizations.find(
      (entry) => entry.sourceVersion === intent.sourceVersion,
    );
    return Boolean(
      source &&
      isSourceAuthorizationCleared(
        auth
          ? {
              ...auth,
              basis: auth.basis ?? undefined,
              declarationVersion: auth.declarationVersion ?? undefined,
              decidedAt: auth.decidedAt ?? undefined,
            }
          : null,
        intent.sourceVersion,
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
        if (attempt >= 4 || !retryable) throw error;
      }
    }
  }
}

export function completeFrameResult(
  intent: {
    id: string;
    cutStartMs: number;
    cutEndMs: number;
    cutResultSizeBytes: bigint;
  },
  result: {
    intentId: string;
    attemptId: string;
    frames: Array<{
      ordinal: number;
      intentId: string;
      attemptId: string;
      measurement: unknown;
      output: {
        intentId: string;
        attemptId: string;
        attemptNumber: number;
        ordinal: number;
        state: string;
        objectKey: string;
        measurement: unknown;
      };
    }>;
  } | null,
): boolean {
  if (!result || result.intentId !== intent.id || result.frames.length !== 3)
    return false;
  for (const [ordinal, frame] of result.frames.entries()) {
    const output = frame.output;
    if (
      frame.ordinal !== ordinal ||
      frame.intentId !== intent.id ||
      frame.attemptId !== result.attemptId ||
      output.intentId !== intent.id ||
      output.attemptId !== result.attemptId ||
      output.ordinal !== ordinal ||
      output.state !== "ACCEPTED" ||
      output.objectKey !==
        `ai-content/frame-evidence/${intent.id}/attempts/${output.attemptNumber}/frames/${ordinal}` ||
      JSON.stringify(frame.measurement) !== JSON.stringify(output.measurement)
    )
      return false;
  }
  try {
    const positions = frameRequestedPositions(
      intent.cutStartMs,
      intent.cutEndMs,
      Number(intent.cutResultSizeBytes),
    );
    validateFrameMeasurements(
      result.frames.map((frame) => frame.measurement as FrameMeasurement),
      positions,
      intent.cutStartMs,
      (intent.cutEndMs - intent.cutStartMs) * 1000,
    );
    return true;
  } catch {
    return false;
  }
}

export function intentCapture(
  intent: FrameEvidenceIntent,
): FrameContextCapture {
  return {
    projectId: intent.projectId,
    sourceId: intent.sourceId,
    sourceVersion: intent.sourceVersion,
    sourceSha256: intent.sourceSha256,
    sourceAuthorizationRevision: intent.sourceAuthorizationRevision,
    sourceAuthorizationBasis: intent.sourceAuthorizationBasis,
    sourceAuthorizationDeclarationVersion:
      intent.sourceAuthorizationDeclarationVersion,
    sourceAuthorizationDecidedAt:
      intent.sourceAuthorizationDecidedAt.toISOString(),
    cutPipelineJobId: intent.cutPipelineJobId,
    cutResultArtifactId: intent.cutResultArtifactId,
    cutResultSha256: intent.cutResultSha256,
    cutResultSizeBytes: intent.cutResultSizeBytes.toString(),
    cutStartMs: intent.cutStartMs,
    cutEndMs: intent.cutEndMs,
    creatorProfileId: intent.creatorProfileId,
    creatorProfileRevisionId: intent.creatorProfileRevisionId,
    creatorProfileRevisionNo: intent.creatorProfileRevisionNo,
    sourceContextId: intent.sourceContextId,
    sourceContextRevisionId: intent.sourceContextRevisionId,
    sourceContextRevisionNo: intent.sourceContextRevisionNo,
    cutPromptId: intent.cutPromptId,
    cutPromptRevisionId: intent.cutPromptRevisionId,
    cutPromptRevisionNo: intent.cutPromptRevisionNo,
  };
}
