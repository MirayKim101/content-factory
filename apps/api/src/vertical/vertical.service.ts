import { createHash, randomUUID } from "node:crypto";

import {
  VERTICAL_APPROVAL_VERSION,
  VERTICAL_OUTPUT,
  VERTICAL_RENDER_CONTRACT_VERSION,
} from "@content-factory/contracts";
import { Inject, Injectable } from "@nestjs/common";

import { apiEnvironment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  VERTICAL_DISPATCH,
  type VerticalDispatch,
} from "./vertical-dispatch.js";

export class VerticalUnavailableError extends Error {}
export class VerticalLineageInvalidError extends Error {}
export class VerticalIdempotencyConflictError extends Error {}
export class VerticalNotFoundError extends Error {}

@Injectable()
export class VerticalService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(VERTICAL_DISPATCH) private readonly dispatch: VerticalDispatch,
  ) {}

  async create(input: {
    projectId: string;
    cutPipelineJobId: string;
    idempotencyKey: string;
  }) {
    if (!apiEnvironment().verticalRenderEnabled)
      throw new VerticalUnavailableError();
    const fingerprint = createHash("sha256")
      .update(
        `${input.projectId}:${input.cutPipelineJobId}:${VERTICAL_RENDER_CONTRACT_VERSION}`,
      )
      .digest("hex");
    const created = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.verticalRenderIntent.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: { job: true, result: { include: { approval: true } } },
        });
        if (existing) {
          if (existing.requestFingerprint !== fingerprint)
            throw new VerticalIdempotencyConflictError();
          return existing;
        }
        const cut = await tx.pipelineJob.findUnique({
          where: { id: input.cutPipelineJobId },
          include: {
            source: { include: { authorizations: true } },
            resultArtifact: true,
          },
        });
        const artifact = cut?.resultArtifact;
        const authorization = cut?.source.authorizations.find(
          (item) => item.sourceVersion === cut.sourceVersion,
        );
        if (
          !cut ||
          cut.projectId !== input.projectId ||
          cut.type !== "CUT_SEGMENT" ||
          cut.state !== "READY" ||
          cut.source.sourceVersion !== cut.sourceVersion ||
          authorization?.status !== "CLEARED" ||
          !artifact ||
          artifact.status !== "READY" ||
          artifact.role !== "CUT_RESULT" ||
          artifact.projectId !== cut.projectId ||
          artifact.lineageSourceId !== cut.sourceId ||
          artifact.lineageSourceVersion !== cut.sourceVersion ||
          artifact.pipelineJobId !== cut.id
        )
          throw new VerticalLineageInvalidError();
        const intentId = randomUUID();
        const jobId = randomUUID();
        await tx.verticalRenderIntent.create({
          data: {
            id: intentId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: fingerprint,
            projectId: cut.projectId,
            sourceId: cut.sourceId,
            sourceVersion: cut.sourceVersion,
            cutPipelineJobId: cut.id,
            cutResultArtifactId: artifact.id,
            framingMode: VERTICAL_OUTPUT.framingMode,
            outputWidth: VERTICAL_OUTPUT.width,
            outputHeight: VERTICAL_OUTPUT.height,
            renderContractVersion: VERTICAL_RENDER_CONTRACT_VERSION,
          },
        });
        await tx.pipelineJob.create({
          data: {
            id: jobId,
            projectId: cut.projectId,
            sourceId: cut.sourceId,
            sourceVersion: cut.sourceVersion,
            type: "RENDER_VERTICAL",
            payloadVersion: 1,
            idempotencyKey: `vertical-render:${intentId}`,
            retryBudget: 2,
            recipeVersion: VERTICAL_RENDER_CONTRACT_VERSION,
            verticalRenderIntentId: intentId,
          },
        });
        return tx.verticalRenderIntent.findUniqueOrThrow({
          where: { id: intentId },
          include: { job: true, result: { include: { approval: true } } },
        });
      },
      { isolationLevel: "Serializable" },
    );
    if (created.job)
      await Promise.allSettled([this.dispatch.dispatch(created.job.id)]);
    return verticalResponse(created);
  }

  async get(id: string) {
    const value = await this.prisma.verticalRenderIntent.findUnique({
      where: { id },
      include: { job: true, result: { include: { approval: true } } },
    });
    return value ? verticalResponse(value) : null;
  }

  async list(projectId: string) {
    const values = await this.prisma.verticalRenderIntent.findMany({
      where: { projectId },
      include: { job: true, result: { include: { approval: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return values.map(verticalResponse);
  }

  async approve(id: string) {
    const intent = await this.prisma.verticalRenderIntent.findUnique({
      where: { id },
      include: {
        job: true,
        result: { include: { artifact: true, approval: true } },
      },
    });
    if (!intent) throw new VerticalNotFoundError();
    if (
      !intent.job ||
      intent.job.state !== "READY" ||
      !intent.result ||
      intent.result.artifact.status !== "READY" ||
      intent.result.artifact.role !== "VERTICAL_RENDER_RESULT" ||
      intent.result.width !== VERTICAL_OUTPUT.width ||
      intent.result.height !== VERTICAL_OUTPUT.height ||
      intent.result.sha256 !== intent.result.artifact.sha256 ||
      intent.result.sizeBytes !== intent.result.artifact.sizeBytes
    )
      throw new VerticalLineageInvalidError();
    if (intent.result.approval) return intent.result.approval;
    return this.prisma.verticalApproval.create({
      data: {
        id: randomUUID(),
        resultId: intent.result.id,
        approvalVersion: VERTICAL_APPROVAL_VERSION,
      },
    });
  }
}

interface VerticalRecord {
  id: string;
  projectId: string;
  cutPipelineJobId: string;
  framingMode: "CENTER_CROP";
  outputWidth: number;
  outputHeight: number;
  renderContractVersion: string;
  createdAt: Date;
  job: {
    id: string;
    state: "QUEUED" | "PROCESSING" | "RETRY_WAIT" | "READY" | "FAILED_FINAL";
    attemptCount: number;
    retryBudget: number;
    failureCode: string | null;
    failureMessage: string | null;
  } | null;
  result: {
    id: string;
    artifactId: string;
    width: number;
    height: number;
    sizeBytes: bigint;
    completedAt: Date;
    approval: { id: string; createdAt: Date } | null;
  } | null;
}

function verticalResponse(value: VerticalRecord) {
  if (!value.job) throw new VerticalLineageInvalidError();
  return {
    id: value.id,
    projectId: value.projectId,
    cutPipelineJobId: value.cutPipelineJobId,
    framingMode: value.framingMode,
    outputWidth: value.outputWidth,
    outputHeight: value.outputHeight,
    renderContractVersion: value.renderContractVersion,
    job: {
      id: value.job.id,
      state: value.job.state,
      attemptCount: value.job.attemptCount,
      retryBudget: value.job.retryBudget,
      failureCode: value.job.failureCode,
      failureMessage: value.job.failureMessage,
    },
    result: value.result
      ? {
          id: value.result.id,
          artifactId: value.result.artifactId,
          width: value.result.width,
          height: value.result.height,
          sizeBytes: value.result.sizeBytes.toString(),
          completedAt: value.result.completedAt,
          approval: value.result.approval
            ? {
                id: value.result.approval.id,
                createdAt: value.result.approval.createdAt,
              }
            : null,
        }
      : null,
    createdAt: value.createdAt,
  };
}
