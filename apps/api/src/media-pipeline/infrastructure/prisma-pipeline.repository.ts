import { randomUUID } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.js";

import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../database/prisma.service.js";
import { sourceAuthorizationRuntime } from "../../config/environment.js";
import {
  CutBoundsInvalidError,
  CutDurationUnavailableError,
  CutIdempotencyConflictError,
  CutSourceNotReadyError,
  type PipelineRepository,
} from "../application/pipeline-repository.port.js";
import type {
  CreateCutsResult,
  PipelineJobView,
} from "../domain/pipeline-job.js";
import {
  isSourceAuthorizationCleared,
  SourceAuthorizationRequiredError,
} from "../../projects/domain/source-authorization.js";
import { HORIZONTAL_RENDER_CONTRACT } from "../../editorial-content/domain/assembly-render.js";
import { EDITORIAL_APPROVAL_CONTRACT } from "../../editorial-content/domain/editorial-approval.js";
import { EDITORIAL_EXPORT_CONTRACT } from "../../editorial-content/domain/editorial-export.js";
import { montageRightsUsable } from "../../editorial-content/domain/montage-asset.js";

interface JobRow {
  id: string;
  revision: number;
  state: PipelineJobView["state"];
  processedMs: number | null;
  totalMs: number | null;
  attemptCount: number;
  retryBudget: number;
  failureCode: string | null;
  failureMessage: string | null;
  failureRetryable: boolean | null;
  updatedAt: Date;
  segment: {
    clientSegmentId: string;
    startMs: number;
    endMs: number;
  } | null;
  resultArtifact: {
    outputFilename: string | null;
    sizeBytes: bigint;
    sha256: string;
  } | null;
}

const jobViewInclude = {
  segment: true,
  resultArtifact: {
    select: { outputFilename: true, sizeBytes: true, sha256: true },
  },
} as const;

const dispatchCandidateSelect = {
  id: true,
  projectId: true,
  sourceId: true,
  sourceVersion: true,
  type: true,
  recipeVersion: true,
  attemptCount: true,
  retryBudget: true,
  editorialExportIntentId: true,
  source: { include: { authorizations: true } },
  editorialExportIntent: {
    include: {
      approval: {
        include: {
          cutPipelineJob: { include: { resultArtifact: true } },
          editorialPackage: true,
          editorialPackageRevision: true,
          processingTemplateRevision: true,
          thumbnailAsset: true,
          assemblyRecipe: true,
          recipeRevisionRecord: {
            include: { assetReferences: { include: { asset: true } } },
          },
          assemblyRenderIntent: {
            include: {
              pipelineJob: true,
              result: { include: { artifact: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.PipelineJobSelect;

type DispatchCandidateRow = Prisma.PipelineJobGetPayload<{
  select: typeof dispatchCandidateSelect;
}>;

const expiredLeaseSelect = {
  ...dispatchCandidateSelect,
  montageAssetId: true,
  leaseToken: true,
} satisfies Prisma.PipelineJobSelect;

@Injectable()
export class PrismaPipelineRepository implements PipelineRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createCuts(input: {
    requestId: string;
    projectId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    segments: Array<{
      clientSegmentId: string;
      startMs: number;
      endMs: number;
    }>;
  }): Promise<{ result: CreateCutsResult; created: boolean }> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const project = await transaction.project.findUnique({
          where: { id: input.projectId },
          include: {
            source: { include: { authorizations: true } },
          },
        });
        if (
          !project?.source ||
          project.status !== "SOURCE_READY" ||
          project.source.status !== "READY"
        )
          throw new CutSourceNotReadyError();
        const authorization = project.source.authorizations.find(
          (decision) =>
            decision.sourceVersion === project.source!.sourceVersion,
        );
        if (!this.isCleared(authorization, project.source.sourceVersion))
          throw new SourceAuthorizationRequiredError();
        const existing = await transaction.cutRequest.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: {
            jobs: { include: jobViewInclude, orderBy: { createdAt: "asc" } },
          },
        });
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint)
            throw new CutIdempotencyConflictError();
          return { result: this.mapRequest(existing), created: false };
        }
        const durationMs = project.source.durationMs;
        if (durationMs === null) throw new CutDurationUnavailableError();
        for (const segment of input.segments) {
          if (
            segment.startMs < 0 ||
            segment.endMs <= segment.startMs ||
            segment.endMs > durationMs
          )
            throw new CutBoundsInvalidError(
              segment.clientSegmentId,
              durationMs,
            );
        }
        const created = await transaction.cutRequest.create({
          data: {
            id: input.requestId,
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            jobs: {
              create: input.segments.map((segment) => ({
                id: randomUUID(),
                projectId: input.projectId,
                sourceId: project.source!.id,
                sourceVersion: project.source!.sourceVersion,
                type: "CUT_SEGMENT" as const,
                idempotencyKey: `cut:${input.idempotencyKey}:${segment.clientSegmentId}`,
                recipeVersion: "stage1-cut-h264-v2",
                totalMs: segment.endMs - segment.startMs,
                segment: {
                  create: {
                    id: randomUUID(),
                    clientSegmentId: segment.clientSegmentId,
                    startMs: segment.startMs,
                    endMs: segment.endMs,
                  },
                },
                attempts: {
                  create: {
                    id: randomUUID(),
                    attemptNumber: 1,
                    state: "QUEUED" as const,
                  },
                },
              })),
            },
          },
          include: { jobs: { include: jobViewInclude } },
        });
        return { result: this.mapRequest(created), created: true };
      });
    } catch (error) {
      if (!this.isUniqueConstraint(error)) throw error;
      const concurrent = await this.findRequest(input.idempotencyKey);
      if (
        !concurrent ||
        concurrent.requestFingerprint !== input.requestFingerprint
      ) {
        throw new CutIdempotencyConflictError();
      }
      return { result: this.mapRequest(concurrent), created: false };
    }
  }

  async getJob(id: string): Promise<PipelineJobView | null> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id, type: "CUT_SEGMENT" },
      include: jobViewInclude,
    });
    return job ? this.mapJob(job) : null;
  }

  async listProjectCutJobs(
    projectId: string,
    limit: number,
  ): Promise<PipelineJobView[]> {
    return this.prisma.$transaction(
      async (transaction) => {
        const project = await transaction.project.findUnique({
          where: { id: projectId },
          select: {
            source: {
              select: { id: true, sourceVersion: true, authorizations: true },
            },
          },
        });
        if (!project?.source) return [];
        const authorization = project.source.authorizations.find(
          (decision) =>
            decision.sourceVersion === project.source!.sourceVersion,
        );
        if (!this.isCleared(authorization, project.source.sourceVersion)) {
          throw new SourceAuthorizationRequiredError();
        }
        const jobs = await transaction.pipelineJob.findMany({
          where: {
            projectId,
            sourceId: project.source.id,
            sourceVersion: project.source.sourceVersion,
            type: "CUT_SEGMENT",
          },
          include: jobViewInclude,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        });
        return jobs.map((job) => this.mapJob(job));
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  async getRunnableJobs(limit: number) {
    const rows = await this.prisma.pipelineJob.findMany({
      where: {
        OR: [
          { state: "QUEUED", nextAttemptAt: null },
          { state: "QUEUED", nextAttemptAt: { lte: new Date() } },
          { state: "RETRY_WAIT", nextAttemptAt: { lte: new Date() } },
        ],
        AND: this.dispatchableType(),
      },
      orderBy: [{ priority: "desc" }, { queuedAt: "asc" }],
      take: Math.max(limit, limit * 4),
      select: dispatchCandidateSelect,
    });
    const current = await this.keepCurrentDispatchCandidates(rows);
    return current.slice(0, limit).map((row) => ({
      jobId: row.id,
      attemptNumber: row.attemptCount + 1,
    }));
  }

  async getRunnableJobsByIds(jobIds: string[]) {
    if (jobIds.length === 0) return [];
    const rows = await this.prisma.pipelineJob.findMany({
      where: {
        id: { in: jobIds },
        OR: [
          { state: "QUEUED", nextAttemptAt: null },
          { state: "QUEUED", nextAttemptAt: { lte: new Date() } },
          { state: "RETRY_WAIT", nextAttemptAt: { lte: new Date() } },
        ],
        AND: this.dispatchableType(),
      },
      select: dispatchCandidateSelect,
    });
    const current = await this.keepCurrentDispatchCandidates(rows);
    return current.map((row) => ({
      jobId: row.id,
      attemptNumber: row.attemptCount + 1,
    }));
  }

  async isDeliveryRunnable(delivery: {
    jobId: string;
    attemptNumber: number;
  }): Promise<boolean> {
    if (delivery.attemptNumber < 1) return false;
    const job = await this.prisma.pipelineJob.findFirst({
      where: {
        id: delivery.jobId,
        OR: [
          { state: "QUEUED", nextAttemptAt: null },
          { state: "QUEUED", nextAttemptAt: { lte: new Date() } },
          { state: "RETRY_WAIT", nextAttemptAt: { lte: new Date() } },
        ],
        attemptCount: delivery.attemptNumber - 1,
        AND: this.dispatchableType(),
      },
      select: dispatchCandidateSelect,
    });
    if (!job) return false;
    if (
      job.type === "EXPORT_EDITORIAL_PACKAGE" &&
      !this.isDispatchCandidateCurrent(job)
    ) {
      await this.failStaleExportCandidate(job.id);
      return false;
    }
    return this.isDispatchCandidateCurrent(job);
  }

  async ensureProbeJobs(limit: number) {
    const sources = await this.prisma.videoSource.findMany({
      where: {
        status: "READY",
        durationMs: null,
        pipelineJobs: { none: { type: "SOURCE_PROBE" } },
      },
      take: Math.max(limit, limit * 4),
      orderBy: { createdAt: "asc" },
      include: { authorizations: true },
    });
    const ids: string[] = [];
    for (const source of sources) {
      if (ids.length >= limit) break;
      const authorization = source.authorizations.find(
        (decision) => decision.sourceVersion === source.sourceVersion,
      );
      if (!this.isCleared(authorization, source.sourceVersion)) continue;
      const id = randomUUID();
      try {
        await this.prisma.pipelineJob.create({
          data: {
            id,
            projectId: source.projectId,
            sourceId: source.id,
            sourceVersion: source.sourceVersion,
            type: "SOURCE_PROBE",
            idempotencyKey: `probe:v1:${source.id}:${source.sourceVersion}`,
            recipeVersion: "source-probe-v1",
            attempts: {
              create: {
                id: randomUUID(),
                attemptNumber: 1,
                state: "QUEUED",
              },
            },
          },
        });
        ids.push(id);
      } catch (error) {
        if (!this.isUniqueConstraint(error)) throw error;
      }
    }
    return ids.map((jobId) => ({ jobId, attemptNumber: 1 }));
  }

  async recoverExpiredLeases(limit: number) {
    const expired = await this.prisma.pipelineJob.findMany({
      where: { state: "PROCESSING", leaseExpiresAt: { lt: new Date() } },
      take: limit,
      orderBy: { leaseExpiresAt: "asc" },
      select: expiredLeaseSelect,
    });
    const recovered: Array<{ jobId: string; attemptNumber: number }> = [];
    for (const job of expired) {
      const authorization = job.source.authorizations.find(
        (decision) => decision.sourceVersion === job.sourceVersion,
      );
      const sourceCurrent =
        job.source.id === job.sourceId &&
        job.source.projectId === job.projectId &&
        job.source.sourceVersion === job.sourceVersion &&
        job.source.status === "READY" &&
        this.isCleared(authorization, job.sourceVersion);
      const exportCurrent =
        job.type !== "EXPORT_EDITORIAL_PACKAGE" || this.isExportCurrent(job);
      if (!sourceCurrent || !exportCurrent) {
        const failureCode =
          job.type === "EXPORT_EDITORIAL_PACKAGE"
            ? "EXPORT_APPROVAL_STALE"
            : job.type === "ASSEMBLE_HORIZONTAL"
              ? "ASSEMBLY_INPUT_INVALID"
              : job.type === "MONTAGE_ASSET_PROBE"
                ? "MONTAGE_IDENTITY_CONFLICT"
                : "SOURCE_AUTHORIZATION_REQUIRED";
        const failureMessage =
          job.type === "EXPORT_EDITORIAL_PACKAGE"
            ? "The exact editorial approval is no longer current or authorized."
            : "Exact source version or authorization changed after admission.";
        await this.prisma.$transaction(async (transaction) => {
          const failed = await transaction.pipelineJob.updateMany({
            where: {
              id: job.id,
              state: "PROCESSING",
              leaseToken: job.leaseToken,
              leaseExpiresAt: { lt: new Date() },
            },
            data: {
              state: "FAILED_FINAL",
              failureCode,
              failureMessage,
              failureRetryable: false,
              finishedAt: new Date(),
              nextAttemptAt: null,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              revision: { increment: 1 },
            },
          });
          if (failed.count !== 1) return;
          await transaction.jobAttempt.updateMany({
            where: { jobId: job.id, state: "PROCESSING" },
            data: {
              state: "FAILED_FINAL",
              failureCode,
              finishedAt: new Date(),
            },
          });
          if (job.type === "MONTAGE_ASSET_PROBE" && job.montageAssetId) {
            await transaction.montageAsset.updateMany({
              where: { id: job.montageAssetId, status: "PROBE_PENDING" },
              data: {
                status: "FAILED_FINAL",
                failureCode,
                failureMessage,
                cleanupStatus: "PENDING",
                revision: { increment: 1 },
              },
            });
          }
        });
        continue;
      }
      const updated = await this.prisma.pipelineJob.updateMany({
        where: {
          id: job.id,
          state: "PROCESSING",
          leaseToken: job.leaseToken,
          leaseExpiresAt: { lt: new Date() },
        },
        data: {
          state: "RETRY_WAIT",
          nextAttemptAt: new Date(Date.now() + 5_000),
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          revision: { increment: 1 },
        },
      });
      if (updated.count === 1) {
        await this.prisma.jobAttempt.updateMany({
          where: { jobId: job.id, state: "PROCESSING" },
          data: {
            state: "FAILED_RETRYABLE",
            failureCode: "WORKER_LEASE_EXPIRED",
            finishedAt: new Date(),
          },
        });
        const row = await this.prisma.pipelineJob.findUniqueOrThrow({
          where: { id: job.id },
          select: { attemptCount: true },
        });
        recovered.push({
          jobId: job.id,
          attemptNumber: row.attemptCount + 1,
        });
      }
    }
    return recovered;
  }

  async getPendingAttemptCleanups(limit: number) {
    const attempts = await this.prisma.jobAttempt.findMany({
      where: {
        cleanupStatus: "PENDING",
        outputObjectKey: { not: null },
      },
      include: {
        job: {
          select: {
            state: true,
            attemptCount: true,
            leaseExpiresAt: true,
            resultArtifact: { select: { objectKey: true } },
          },
        },
      },
      orderBy: { updatedAt: "asc" },
      take: Math.max(limit, limit * 4),
    });
    const now = Date.now();
    return attempts
      .filter(
        (attempt) =>
          attempt.outputObjectKey !== null &&
          attempt.job.resultArtifact?.objectKey !== attempt.outputObjectKey &&
          (attempt.job.state !== "PROCESSING" ||
            attempt.job.attemptCount !== attempt.attemptNumber ||
            (attempt.job.leaseExpiresAt?.getTime() ?? 0) < now),
      )
      .slice(0, limit)
      .map((attempt) => ({
        jobId: attempt.jobId,
        attemptNumber: attempt.attemptNumber,
        objectKey: attempt.outputObjectKey!,
        updatedAt: attempt.updatedAt,
      }));
  }

  async reserveAttemptCleanup(cleanup: {
    jobId: string;
    attemptNumber: number;
    objectKey: string;
    updatedAt: Date;
  }): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "JobAttempt" AS attempt
         SET "cleanupAttemptCount" = attempt."cleanupAttemptCount" + 1,
             "updatedAt" = now()
        FROM "PipelineJob" AS job
       WHERE attempt."jobId" = ${cleanup.jobId}::uuid
         AND attempt."attemptNumber" = ${cleanup.attemptNumber}
         AND attempt."outputObjectKey" = ${cleanup.objectKey}
         AND attempt."updatedAt" = ${cleanup.updatedAt}
         AND attempt."cleanupStatus" = 'PENDING'
         AND job."id" = attempt."jobId"
         AND (
           job."state" <> 'PROCESSING'
           OR job."attemptCount" <> attempt."attemptNumber"
           OR job."leaseExpiresAt" < now()
         )
         AND NOT EXISTS (
           SELECT 1 FROM "MediaArtifact" artifact
            WHERE artifact."pipelineJobId" = job."id"
              AND artifact."status" = 'READY'
              AND artifact."objectKey" = attempt."outputObjectKey"
         )`;
    return updated === 1;
  }

  async completeAttemptCleanup(cleanup: {
    jobId: string;
    attemptNumber: number;
    objectKey: string;
    updatedAt: Date;
  }): Promise<void> {
    await this.prisma.jobAttempt.updateMany({
      where: {
        jobId: cleanup.jobId,
        attemptNumber: cleanup.attemptNumber,
        outputObjectKey: cleanup.objectKey,
        cleanupStatus: "PENDING",
      },
      data: {
        cleanupStatus: "COMPLETED",
        cleanupLastErrorCode: null,
        cleanupCompletedAt: new Date(),
      },
    });
  }

  async failAttemptCleanup(
    cleanup: {
      jobId: string;
      attemptNumber: number;
      objectKey: string;
      updatedAt: Date;
    },
    code: string,
  ): Promise<void> {
    await this.prisma.jobAttempt.updateMany({
      where: {
        jobId: cleanup.jobId,
        attemptNumber: cleanup.attemptNumber,
        outputObjectKey: cleanup.objectKey,
        cleanupStatus: "PENDING",
      },
      data: { cleanupLastErrorCode: code },
    });
  }

  async getSourceObject(projectId: string) {
    return this.prisma.$transaction(
      async (transaction) => {
        const source = await transaction.videoSource.findUnique({
          where: { projectId },
          include: { authorizations: true },
        });
        const authorization = source?.authorizations.find(
          (decision) => decision.sourceVersion === source.sourceVersion,
        );
        if (!source || !this.isCleared(authorization, source.sourceVersion))
          throw new SourceAuthorizationRequiredError();
        const artifact = await transaction.mediaArtifact.findFirst({
          where: {
            projectId,
            sourceId: source.id,
            lineageSourceId: source.id,
            lineageSourceVersion: source.sourceVersion,
            role: "SOURCE",
            status: "READY",
          },
        });
        return artifact
          ? {
              objectKey: artifact.objectKey,
              sizeBytes: artifact.sizeBytes,
              filename: source.originalFilename,
            }
          : null;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async getResultObject(jobId: string) {
    return this.prisma.$transaction(
      async (transaction) => {
        const job = await transaction.pipelineJob.findUnique({
          where: { id: jobId },
          include: { source: { include: { authorizations: true } } },
        });
        const authorization = job?.source.authorizations.find(
          (decision) => decision.sourceVersion === job.sourceVersion,
        );
        if (!job || !this.isCleared(authorization, job.sourceVersion))
          throw new SourceAuthorizationRequiredError();
        const artifact = await transaction.mediaArtifact.findFirst({
          where: {
            pipelineJobId: job.id,
            sourceId: job.sourceId,
            lineageSourceId: job.sourceId,
            lineageSourceVersion: job.sourceVersion,
            role: "CUT_RESULT",
            status: "READY",
          },
        });
        return artifact?.outputFilename
          ? {
              objectKey: artifact.objectKey,
              sizeBytes: artifact.sizeBytes,
              filename: artifact.outputFilename,
            }
          : null;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async requireProjectAuthorization(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { source: { include: { authorizations: true } } },
    });
    const source = project?.source;
    const authorization = source?.authorizations.find(
      (decision) => decision.sourceVersion === source.sourceVersion,
    );
    if (!source || !this.isCleared(authorization, source.sourceVersion))
      throw new SourceAuthorizationRequiredError();
  }

  async requireJobAuthorization(jobId: string): Promise<void> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
      include: { source: { include: { authorizations: true } } },
    });
    const authorization = job?.source.authorizations.find(
      (decision) => decision.sourceVersion === job.sourceVersion,
    );
    if (!job || !this.isCleared(authorization, job.sourceVersion))
      throw new SourceAuthorizationRequiredError();
  }

  private isCleared(
    authorization:
      | {
          sourceVersion: number;
          status: "NOT_REVIEWED" | "CLEARED";
          basis:
            | "LEGACY_ATTESTATION"
            | "OPERATOR_ATTESTATION"
            | "LOCAL_DEVELOPMENT_AUTO"
            | null;
          declarationVersion: string | null;
          decidedAt: Date | null;
          revision: number;
        }
      | null
      | undefined,
    sourceVersion: number,
  ): boolean {
    return isSourceAuthorizationCleared(
      authorization
        ? {
            sourceVersion: authorization.sourceVersion,
            status: authorization.status,
            ...(authorization.basis ? { basis: authorization.basis } : {}),
            ...(authorization.declarationVersion
              ? { declarationVersion: authorization.declarationVersion }
              : {}),
            ...(authorization.decidedAt
              ? { decidedAt: authorization.decidedAt }
              : {}),
            revision: authorization.revision,
          }
        : null,
      sourceVersion,
      sourceAuthorizationRuntime().policy,
    );
  }

  private async keepCurrentDispatchCandidates(
    rows: DispatchCandidateRow[],
  ): Promise<DispatchCandidateRow[]> {
    const current: DispatchCandidateRow[] = [];
    for (const row of rows) {
      if (this.isDispatchCandidateCurrent(row)) {
        current.push(row);
        continue;
      }
      if (row.type === "EXPORT_EDITORIAL_PACKAGE") {
        await this.failStaleExportCandidate(row.id);
      }
    }
    return current;
  }

  private async failStaleExportCandidate(jobId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const failed = await transaction.pipelineJob.updateMany({
        where: {
          id: jobId,
          type: "EXPORT_EDITORIAL_PACKAGE",
          state: { in: ["QUEUED", "RETRY_WAIT"] },
        },
        data: {
          state: "FAILED_FINAL",
          failureCode: "EXPORT_APPROVAL_STALE",
          failureMessage:
            "The exact editorial approval is no longer current or authorized.",
          failureRetryable: false,
          finishedAt: new Date(),
          nextAttemptAt: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          revision: { increment: 1 },
        },
      });
      if (failed.count !== 1) return;
      await transaction.jobAttempt.updateMany({
        where: { jobId, state: "QUEUED" },
        data: {
          state: "FAILED_FINAL",
          failureCode: "EXPORT_APPROVAL_STALE",
          finishedAt: new Date(),
        },
      });
    });
  }

  private isDispatchCandidateCurrent(row: DispatchCandidateRow): boolean {
    const authorization = row.source.authorizations.find(
      (decision) => decision.sourceVersion === row.sourceVersion,
    );
    if (
      row.source.id !== row.sourceId ||
      row.source.projectId !== row.projectId ||
      row.source.sourceVersion !== row.sourceVersion ||
      row.source.status !== "READY" ||
      !this.isCleared(authorization, row.sourceVersion)
    ) {
      return false;
    }
    return row.type !== "EXPORT_EDITORIAL_PACKAGE" || this.isExportCurrent(row);
  }

  private isExportCurrent(row: DispatchCandidateRow): boolean {
    const intent = row.editorialExportIntent;
    const approval = intent?.approval;
    const render = approval?.assemblyRenderIntent;
    const recipeRevision = approval?.recipeRevisionRecord;
    if (!intent || !approval || !render || !recipeRevision) return false;

    const tags = approval.editorialPackageRevision.tags;
    const editorialComplete =
      Boolean(approval.editorialPackageRevision.title?.trim()) &&
      Boolean(approval.editorialPackageRevision.description?.trim()) &&
      Array.isArray(tags) &&
      tags.length > 0;
    const montageInputsCurrent = recipeRevision.assetReferences.every(
      (reference) =>
        reference.asset.id === reference.assetId &&
        reference.asset.projectId === approval.projectId &&
        reference.asset.sourceId === approval.sourceId &&
        reference.asset.sourceVersion === approval.sourceVersion &&
        reference.asset.status === "READY" &&
        reference.asset.revision === reference.assetRevision &&
        reference.asset.sha256 === reference.assetSha256 &&
        reference.asset.sizeBytes === reference.assetSizeBytes &&
        reference.asset.kind === reference.assetKind &&
        reference.asset.durationMs === reference.assetDurationMs &&
        montageRightsUsable(
          reference.asset,
          sourceAuthorizationRuntime().policy,
        ),
    );

    return (
      row.recipeVersion === EDITORIAL_EXPORT_CONTRACT &&
      row.editorialExportIntentId === intent.id &&
      intent.projectId === row.projectId &&
      intent.sourceId === row.sourceId &&
      intent.sourceVersion === row.sourceVersion &&
      intent.exportContractVersion === EDITORIAL_EXPORT_CONTRACT &&
      intent.projectId === approval.projectId &&
      intent.sourceId === approval.sourceId &&
      intent.sourceVersion === approval.sourceVersion &&
      intent.cutPipelineJobId === approval.cutPipelineJobId &&
      intent.approvalCandidateFingerprint === approval.candidateFingerprint &&
      intent.editorialPackageRevisionId ===
        approval.editorialPackageRevisionId &&
      intent.recipeRevisionId === approval.recipeRevisionId &&
      intent.assemblyRenderResultId === approval.assemblyRenderResultId &&
      approval.approvalContractVersion === EDITORIAL_APPROVAL_CONTRACT &&
      approval.renderContractVersion === HORIZONTAL_RENDER_CONTRACT &&
      approval.editorialPackage.currentRevision ===
        approval.editorialRevision &&
      approval.editorialPackage.projectId === approval.projectId &&
      approval.editorialPackage.pipelineJobId === approval.cutPipelineJobId &&
      approval.editorialPackage.cutResultArtifactId ===
        approval.cutPipelineJob.resultArtifact?.id &&
      approval.editorialPackage.cutResultSha256 ===
        approval.cutPipelineJob.resultArtifact.sha256 &&
      approval.editorialPackage.cutResultSizeBytes ===
        approval.cutPipelineJob.resultArtifact.sizeBytes &&
      approval.editorialPackage.cutResultRecipeVersion ===
        approval.cutPipelineJob.recipeVersion &&
      approval.editorialPackage.lineageSourceId === approval.sourceId &&
      approval.editorialPackage.lineageSourceVersion ===
        approval.sourceVersion &&
      approval.editorialPackageRevision.id ===
        approval.editorialPackageRevisionId &&
      approval.editorialPackageRevision.packageId ===
        approval.editorialPackageId &&
      approval.editorialPackageRevision.revision ===
        approval.editorialRevision &&
      approval.editorialPackageRevision.processingTemplateRevisionId ===
        approval.processingTemplateRevisionId &&
      approval.processingTemplateRevision.id ===
        approval.processingTemplateRevisionId &&
      approval.processingTemplateRevision.configurationVersion ===
        "manual-editorial-v1" &&
      approval.editorialPackageRevision.thumbnailAssetId ===
        approval.thumbnailAssetId &&
      editorialComplete &&
      approval.cutPipelineJob.type === "CUT_SEGMENT" &&
      approval.cutPipelineJob.state === "READY" &&
      approval.cutPipelineJob.projectId === approval.projectId &&
      approval.cutPipelineJob.sourceId === approval.sourceId &&
      approval.cutPipelineJob.sourceVersion === approval.sourceVersion &&
      approval.cutPipelineJob.resultArtifact?.role === "CUT_RESULT" &&
      approval.cutPipelineJob.resultArtifact.status === "READY" &&
      approval.cutPipelineJob.resultArtifact.projectId === approval.projectId &&
      approval.cutPipelineJob.resultArtifact.sourceId === approval.sourceId &&
      approval.cutPipelineJob.resultArtifact.lineageSourceId ===
        approval.sourceId &&
      approval.cutPipelineJob.resultArtifact.lineageSourceVersion ===
        approval.sourceVersion &&
      approval.cutPipelineJob.resultArtifact.pipelineJobId ===
        approval.cutPipelineJob.id &&
      approval.cutPipelineJob.resultArtifact.recipeVersion ===
        approval.cutPipelineJob.recipeVersion &&
      approval.thumbnailAsset.projectId === approval.projectId &&
      approval.thumbnailAsset.type === "THUMBNAIL" &&
      approval.thumbnailAsset.status === "READY" &&
      approval.thumbnailAsset.sha256 === approval.thumbnailSha256 &&
      approval.thumbnailAsset.sizeBytes === approval.thumbnailSizeBytes &&
      approval.thumbnailAsset.contentType === approval.thumbnailContentType &&
      ["image/jpeg", "image/png", "image/webp"].includes(
        approval.thumbnailAsset.contentType,
      ) &&
      approval.assemblyRecipe.currentRevision === approval.recipeRevision &&
      recipeRevision.id === approval.recipeRevisionId &&
      recipeRevision.recipeId === approval.assemblyRecipeId &&
      recipeRevision.revision === approval.recipeRevision &&
      recipeRevision.configurationFingerprint ===
        approval.configurationFingerprint &&
      recipeRevision.schemaVersion === "horizontal-assembly-v1" &&
      recipeRevision.audioProfileVersion === "youtube-stereo-v1" &&
      recipeRevision.encodingProfileVersion === "youtube-h264-v1" &&
      montageInputsCurrent &&
      render.id === approval.assemblyRenderIntentId &&
      render.projectId === approval.projectId &&
      render.sourceId === approval.sourceId &&
      render.sourceVersion === approval.sourceVersion &&
      render.cutPipelineJobId === approval.cutPipelineJobId &&
      render.assemblyRecipeId === approval.assemblyRecipeId &&
      render.recipeRevisionId === approval.recipeRevisionId &&
      render.recipeRevision === approval.recipeRevision &&
      render.configurationFingerprint === approval.configurationFingerprint &&
      render.renderContractVersion === HORIZONTAL_RENDER_CONTRACT &&
      render.audioProfileVersion === recipeRevision.audioProfileVersion &&
      render.encodingProfileVersion === recipeRevision.encodingProfileVersion &&
      render.pipelineJob?.type === "ASSEMBLE_HORIZONTAL" &&
      render.pipelineJob.state === "READY" &&
      render.pipelineJob.projectId === approval.projectId &&
      render.pipelineJob.sourceId === approval.sourceId &&
      render.pipelineJob.sourceVersion === approval.sourceVersion &&
      render.pipelineJob.assemblyRenderIntentId === render.id &&
      render.result?.id === approval.assemblyRenderResultId &&
      render.result.renderIntentId === render.id &&
      render.result.artifact.id === approval.renderArtifactId &&
      render.result.artifact.projectId === approval.projectId &&
      render.result.artifact.sourceId === approval.sourceId &&
      render.result.artifact.lineageSourceId === approval.sourceId &&
      render.result.artifact.lineageSourceVersion === approval.sourceVersion &&
      render.result.artifact.pipelineJobId === render.pipelineJob.id &&
      render.result.artifact.role === "HORIZONTAL_ASSEMBLY_RESULT" &&
      render.result.artifact.status === "READY" &&
      render.result.artifact.contentType === "video/mp4" &&
      render.result.artifact.recipeVersion === HORIZONTAL_RENDER_CONTRACT &&
      render.result.artifact.sha256 === approval.renderArtifactSha256 &&
      render.result.artifact.sizeBytes === approval.renderArtifactSizeBytes
    );
  }

  private findRequest(key: string) {
    return this.prisma.cutRequest.findUnique({
      where: { idempotencyKey: key },
      include: {
        jobs: { include: jobViewInclude, orderBy: { createdAt: "asc" } },
      },
    });
  }

  private mapRequest(row: {
    id: string;
    projectId: string;
    jobs: JobRow[];
  }): CreateCutsResult {
    return {
      requestId: row.id,
      projectId: row.projectId,
      jobs: row.jobs.map((job) => this.mapJob(job)),
    };
  }

  private mapJob(job: JobRow): PipelineJobView {
    if (!job.segment) throw new Error("CUT_SEGMENT_MISSING");
    return {
      id: job.id,
      clientSegmentId: job.segment.clientSegmentId,
      revision: job.revision,
      state: job.state,
      startMs: job.segment.startMs,
      endMs: job.segment.endMs,
      ...(job.processedMs === null ? {} : { processedMs: job.processedMs }),
      ...(job.totalMs === null ? {} : { totalMs: job.totalMs }),
      attempt: job.attemptCount,
      retryBudget: job.retryBudget,
      ...(job.failureCode && job.failureMessage
        ? {
            failure: {
              code: job.failureCode,
              message: job.failureMessage,
              retryable: job.failureRetryable ?? false,
            },
          }
        : {}),
      ...(job.resultArtifact?.outputFilename
        ? {
            result: {
              filename: job.resultArtifact.outputFilename,
              sizeBytes: job.resultArtifact.sizeBytes,
              sha256: job.resultArtifact.sha256,
            },
          }
        : {}),
      updatedAt: job.updatedAt,
    };
  }

  private isUniqueConstraint(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    );
  }

  private dispatchableType(): Prisma.PipelineJobWhereInput {
    return {
      payloadVersion: 1,
      OR: [
        { type: { in: ["SOURCE_PROBE", "CUT_SEGMENT"] }, montageAssetId: null },
        {
          type: "ASSEMBLE_HORIZONTAL",
          recipeVersion: HORIZONTAL_RENDER_CONTRACT,
          montageAssetId: null,
          assemblyRenderIntent: {
            is: {
              renderContractVersion: HORIZONTAL_RENDER_CONTRACT,
            },
          },
        },
        {
          type: "EXPORT_EDITORIAL_PACKAGE",
          recipeVersion: EDITORIAL_EXPORT_CONTRACT,
          montageAssetId: null,
          cutRequestId: null,
          assemblyRenderIntentId: null,
          editorialExportIntent: {
            is: { exportContractVersion: EDITORIAL_EXPORT_CONTRACT },
          },
        },
        ...(sourceAuthorizationRuntime().policy === "local-auto"
          ? [
              {
                type: "MONTAGE_ASSET_PROBE" as const,
                recipeVersion: "montage-asset-probe-v1",
                montageAsset: {
                  is: {
                    status: "PROBE_PENDING" as const,
                    kind: { not: "BANNER" as const },
                    rightsBasis: "LOCAL_DEVELOPMENT_AUTO",
                    rightsDeclaration: "montage-local-development-auto-v1",
                  },
                },
              },
            ]
          : []),
      ],
    };
  }
}
