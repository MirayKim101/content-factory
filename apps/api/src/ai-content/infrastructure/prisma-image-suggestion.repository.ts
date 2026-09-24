import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { THUMBNAIL_CONTRACT_VERSION, type FrameContextCapture, type FrameContextFacts } from "@content-factory/contracts";

import { apiEnvironment } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { AiContentIdempotencyConflictError } from "../application/creator-context-repository.port.js";
import {
  ImageSuggestionContextRejectedError,
  type ImageSuggestionRepository,
  type ImageSuggestionView,
} from "../application/image-suggestion-repository.port.js";
import {
  frameContextFingerprint,
  FrameContextRejectedError,
  lockedFrameContext,
  requireFrameContext,
} from "./prisma-frame-context.js";

const ADAPTER_VERSION = "local-no-likeness-png-v1";
const PROMPT_BASIS_VERSION = "local-abstract-thumbnail-prompt-v1";

const include = { candidate: true } satisfies Prisma.ImageSuggestionIntentInclude;
type Row = Prisma.ImageSuggestionIntentGetPayload<{ include: typeof include }>;

@Injectable()
export class PrismaImageSuggestionRepository implements ImageSuggestionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    projectId: string;
    cutPipelineJobId: string;
    sourceContextRevisionId: string;
    cutPromptRevisionId: string;
    idempotencyKey: string;
  }): Promise<string> {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([THUMBNAIL_CONTRACT_VERSION, "CREATE_IMAGE_SUGGESTION", input.projectId, input.cutPipelineJobId, input.sourceContextRevisionId, input.cutPromptRevisionId, ADAPTER_VERSION, PROMPT_BASIS_VERSION]))
      .digest("hex");
    return this.serializable(async (tx) => {
      const previous = await tx.aiContentOperationRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (previous) {
        if (previous.operation !== "CREATE_IMAGE_SUGGESTION" || previous.canonicalRequestFingerprint !== fingerprint || previous.resultType !== "IMAGE_SUGGESTION")
          throw new AiContentIdempotencyConflictError();
        return previous.resultId;
      }
      const facts = this.requireImageContext(
        await lockedFrameContext(tx, input),
        "IMAGE_CONTEXT_REQUIRED",
      );
      const capture = facts.capture;
      if (capture.projectId !== input.projectId)
        throw new ImageSuggestionContextRejectedError("IMAGE_CONTEXT_REQUIRED");
      const id = randomUUID();
      await tx.imageSuggestionIntent.create({ data: {
        id, idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint,
        projectId: capture.projectId, sourceId: capture.sourceId, sourceVersion: capture.sourceVersion,
        sourceSha256: capture.sourceSha256, sourceAuthorizationRevision: capture.sourceAuthorizationRevision,
        sourceAuthorizationBasis: capture.sourceAuthorizationBasis,
        sourceAuthorizationDeclarationVersion: capture.sourceAuthorizationDeclarationVersion,
        sourceAuthorizationDecidedAt: new Date(capture.sourceAuthorizationDecidedAt),
        cutPipelineJobId: capture.cutPipelineJobId, cutResultArtifactId: capture.cutResultArtifactId,
        cutResultSha256: capture.cutResultSha256, cutResultSizeBytes: BigInt(capture.cutResultSizeBytes),
        cutStartMs: capture.cutStartMs, cutEndMs: capture.cutEndMs,
        creatorProfileId: capture.creatorProfileId, creatorProfileRevisionId: capture.creatorProfileRevisionId,
        creatorProfileRevisionNo: capture.creatorProfileRevisionNo, sourceContextId: capture.sourceContextId,
        sourceContextRevisionId: capture.sourceContextRevisionId, sourceContextRevisionNo: capture.sourceContextRevisionNo,
        cutPromptId: capture.cutPromptId, cutPromptRevisionId: capture.cutPromptRevisionId,
        cutPromptRevisionNo: capture.cutPromptRevisionNo, contextPolicyFingerprint: frameContextFingerprint(capture),
        contractVersion: THUMBNAIL_CONTRACT_VERSION, adapterVersion: ADAPTER_VERSION,
        promptBasisVersion: PROMPT_BASIS_VERSION,
      }});
      await tx.aiContentOperationRequest.create({ data: {
        id: randomUUID(), idempotencyKey: input.idempotencyKey, operation: "CREATE_IMAGE_SUGGESTION",
        canonicalRequestFingerprint: fingerprint, resolvedProjectId: capture.projectId,
        resolvedSourceId: capture.sourceId, resolvedSourceVersion: capture.sourceVersion,
        resultType: "IMAGE_SUGGESTION", resultId: id,
      }});
      return id;
    });
  }

  async detail(intentId: string) {
    const row = await this.prisma.imageSuggestionIntent.findUnique({ where: { id: intentId }, include });
    return row ? this.map(row) : null;
  }

  async list(cutPipelineJobId: string) {
    const rows = await this.prisma.imageSuggestionIntent.findMany({ where: { cutPipelineJobId }, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
    return rows.map((row) => this.map(row));
  }

  async resolveForApply(intentId: string) {
    return this.serializable(async (tx) => {
      const row = await tx.imageSuggestionIntent.findUnique({ where: { id: intentId }, include });
      if (!row || row.state !== "READY" || !row.candidate)
        throw new ImageSuggestionContextRejectedError("IMAGE_SUGGESTION_NOT_READY");
      await this.requireCurrent(tx, row);
      return { pipelineJobId: row.cutPipelineJobId, imageIntentId: row.id, candidate: this.map(row).candidate! };
    });
  }

  async resolveContent(intentId: string, candidateId: string) {
    return this.serializable(async (tx) => {
      const row = await tx.imageSuggestionIntent.findUnique({ where: { id: intentId }, include });
      if (!row || row.state !== "READY" || !row.candidate || row.candidate.id !== candidateId) return null;
      await this.requireCurrent(tx, row);
      return { projectId: row.projectId, objectKey: row.candidate.objectKey, contentType: "image/png" as const, sizeBytes: row.candidate.sizeBytes, sha256: row.candidate.sha256 };
    });
  }

  private async requireCurrent(tx: Prisma.TransactionClient, row: Row) {
    const capture = this.capture(row);
    this.requireImageContext(
      await lockedFrameContext(tx, { cutPipelineJobId: row.cutPipelineJobId, sourceContextRevisionId: row.sourceContextRevisionId, cutPromptRevisionId: row.cutPromptRevisionId }),
      "IMAGE_CONTEXT_STALE",
      capture,
    );
    if (frameContextFingerprint(capture) !== row.contextPolicyFingerprint)
      throw new ImageSuggestionContextRejectedError("IMAGE_CONTEXT_STALE");
  }

  private capture(row: Row): FrameContextCapture {
    return { projectId: row.projectId, sourceId: row.sourceId, sourceVersion: row.sourceVersion, sourceSha256: row.sourceSha256,
      sourceAuthorizationRevision: row.sourceAuthorizationRevision, sourceAuthorizationBasis: row.sourceAuthorizationBasis,
      sourceAuthorizationDeclarationVersion: row.sourceAuthorizationDeclarationVersion, sourceAuthorizationDecidedAt: row.sourceAuthorizationDecidedAt.toISOString(),
      cutPipelineJobId: row.cutPipelineJobId, cutResultArtifactId: row.cutResultArtifactId, cutResultSha256: row.cutResultSha256,
      cutResultSizeBytes: row.cutResultSizeBytes.toString(), cutStartMs: row.cutStartMs, cutEndMs: row.cutEndMs,
      creatorProfileId: row.creatorProfileId, creatorProfileRevisionId: row.creatorProfileRevisionId, creatorProfileRevisionNo: row.creatorProfileRevisionNo,
      sourceContextId: row.sourceContextId, sourceContextRevisionId: row.sourceContextRevisionId, sourceContextRevisionNo: row.sourceContextRevisionNo,
      cutPromptId: row.cutPromptId, cutPromptRevisionId: row.cutPromptRevisionId, cutPromptRevisionNo: row.cutPromptRevisionNo };
  }

  private requireImageContext(
    facts: FrameContextFacts | null,
    code: string,
    captured?: FrameContextCapture,
  ): FrameContextFacts {
    try {
      return requireFrameContext(
        facts,
        apiEnvironment().sourceAuthorizationPolicy,
        captured,
      );
    } catch (error) {
      if (error instanceof FrameContextRejectedError)
        throw new ImageSuggestionContextRejectedError(code);
      throw error;
    }
  }

  private map(row: Row): ImageSuggestionView {
    const candidate = row.candidate;
    return { id: row.id, projectId: row.projectId, cutPipelineJobId: row.cutPipelineJobId, state: row.state, contractVersion: row.contractVersion,
      adapterVersion: row.adapterVersion, promptBasisVersion: row.promptBasisVersion,
      candidate: candidate ? { id: candidate.id, contentType: "image/png", sizeBytes: candidate.sizeBytes.toString(), sha256: candidate.sha256,
        width: candidate.width, height: candidate.height, likeness: "NONE", safetyDecision: candidate.safetyDecision,
        directCostMicrousd: candidate.directCostMicrousd.toString(), costBasisVersion: candidate.costBasisVersion } : null,
      failure: row.failureCode && row.failureMessage ? { code: row.failureCode, message: row.failureMessage } : null,
      createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, attempt = 0): Promise<T> {
    try { return await this.prisma.$transaction(operation, { isolationLevel: "Serializable" }); }
    catch (error) {
      if (attempt < 4 && typeof error === "object" && error !== null && "code" in error && ["P2034", "P2002", "P2010"].includes(String(error.code))) {
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        return this.serializable(operation, attempt + 1);
      }
      throw error;
    }
  }
}
