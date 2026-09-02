import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../database/prisma.service.js";
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
    const existing = await this.findRequest(input.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new CutIdempotencyConflictError();
      }
      return { result: this.mapRequest(existing), created: false };
    }

    const source = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      include: { source: true },
    });
    if (
      !source?.source ||
      source.status !== "SOURCE_READY" ||
      source.source.status !== "READY"
    ) {
      throw new CutSourceNotReadyError();
    }
    const durationMs = source.source.durationMs;
    if (durationMs === null) throw new CutDurationUnavailableError();
    for (const segment of input.segments) {
      if (
        segment.startMs < 0 ||
        segment.endMs <= segment.startMs ||
        segment.endMs > durationMs
      ) {
        throw new CutBoundsInvalidError(segment.clientSegmentId, durationMs);
      }
    }

    try {
      const created = await this.prisma.cutRequest.create({
        data: {
          id: input.requestId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          jobs: {
            create: input.segments.map((segment) => {
              const jobId = randomUUID();
              return {
                id: jobId,
                projectId: input.projectId,
                sourceId: source.source!.id,
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
              };
            }),
          },
        },
        include: { jobs: { include: jobViewInclude } },
      });
      return { result: this.mapRequest(created), created: true };
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

  async getRunnableJobs(limit: number) {
    const rows = await this.prisma.pipelineJob.findMany({
      where: { state: { in: ["QUEUED", "RETRY_WAIT"] } },
      orderBy: [{ priority: "desc" }, { queuedAt: "asc" }],
      take: limit,
      select: { id: true, attemptCount: true },
    });
    return rows.map((row) => ({
      jobId: row.id,
      attemptNumber: row.attemptCount + 1,
    }));
  }

  async getRunnableJobsByIds(jobIds: string[]) {
    if (jobIds.length === 0) return [];
    const rows = await this.prisma.pipelineJob.findMany({
      where: {
        id: { in: jobIds },
        state: { in: ["QUEUED", "RETRY_WAIT"] },
      },
      select: { id: true, attemptCount: true },
    });
    return rows.map((row) => ({
      jobId: row.id,
      attemptNumber: row.attemptCount + 1,
    }));
  }

  async isDeliveryRunnable(delivery: {
    jobId: string;
    attemptNumber: number;
  }): Promise<boolean> {
    if (delivery.attemptNumber < 1) return false;
    return (
      (await this.prisma.pipelineJob.count({
        where: {
          id: delivery.jobId,
          state: { in: ["QUEUED", "RETRY_WAIT"] },
          attemptCount: delivery.attemptNumber - 1,
        },
      })) === 1
    );
  }

  async ensureProbeJobs(limit: number) {
    const sources = await this.prisma.videoSource.findMany({
      where: {
        status: "READY",
        durationMs: null,
        pipelineJobs: { none: { type: "SOURCE_PROBE" } },
      },
      take: limit,
      orderBy: { createdAt: "asc" },
      select: { id: true, projectId: true, sourceVersion: true },
    });
    const ids: string[] = [];
    for (const source of sources) {
      const id = randomUUID();
      try {
        await this.prisma.pipelineJob.create({
          data: {
            id,
            projectId: source.projectId,
            sourceId: source.id,
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
      select: { id: true, leaseToken: true },
    });
    const recovered: Array<{ jobId: string; attemptNumber: number }> = [];
    for (const job of expired) {
      const updated = await this.prisma.pipelineJob.updateMany({
        where: {
          id: job.id,
          state: "PROCESSING",
          leaseToken: job.leaseToken,
          leaseExpiresAt: { lt: new Date() },
        },
        data: {
          state: "RETRY_WAIT",
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
    const artifact = await this.prisma.mediaArtifact.findFirst({
      where: { projectId, role: "SOURCE", status: "READY" },
      include: { source: { select: { originalFilename: true } } },
    });
    return artifact
      ? {
          objectKey: artifact.objectKey,
          sizeBytes: artifact.sizeBytes,
          filename: artifact.source.originalFilename,
        }
      : null;
  }

  async getResultObject(jobId: string) {
    const artifact = await this.prisma.mediaArtifact.findFirst({
      where: {
        pipelineJobId: jobId,
        role: "CUT_RESULT",
        status: "READY",
      },
    });
    return artifact && artifact.outputFilename
      ? {
          objectKey: artifact.objectKey,
          sizeBytes: artifact.sizeBytes,
          filename: artifact.outputFilename,
        }
      : null;
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
}
