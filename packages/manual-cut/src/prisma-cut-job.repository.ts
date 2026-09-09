import type {
  MediaArtifact,
  PipelineJob,
  Prisma,
  PrismaClient,
} from "@content-factory/prisma-client";

import {
  CUT_RECIPE_VERSION,
  type CutJobView,
  type PageCursor,
} from "./domain.js";
import type {
  ActiveLease,
  AuthorizedMediaResult,
  ClaimCutResult,
  CompletedArtifact,
  CreateCutJobInput,
  CreateCutJobResult,
  CutJobReadResult,
  CutJobRepository,
  PendingOutputCleanup,
} from "./ports.js";

type Transaction = Prisma.TransactionClient;
type JobWithArtifact = PipelineJob & { winningArtifact: MediaArtifact | null };

export class PrismaCutJobRepository implements CutJobRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(input: CreateCutJobInput): Promise<CreateCutJobResult> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "VideoSource" WHERE "projectId" = ${input.projectId}::uuid FOR SHARE`;
        const gate = await this.sourceGate(tx, input.projectId);
        if (gate.outcome !== "CLEARED") return gate;
        await tx.$queryRaw`SELECT "sourceId" FROM "SourceAuthorization" WHERE "sourceId" = ${gate.source.id}::uuid AND "sourceVersion" = ${gate.source.sourceVersion} FOR SHARE`;
        const lockedGate = await this.sourceGate(tx, input.projectId);
        if (lockedGate.outcome !== "CLEARED") return lockedGate;
        const requestFingerprint = cutFingerprint({
          projectId: input.projectId,
          sourceId: lockedGate.source.id,
          sourceVersion: lockedGate.source.sourceVersion,
          sourceSha256: lockedGate.source.sha256,
          startMs: input.startMs,
          endMs: input.endMs,
        });
        const existing = await tx.pipelineJob.findUnique({
          where: {
            projectId_idempotencyKey: {
              projectId: input.projectId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: { winningArtifact: true },
        });
        if (existing) {
          return existing.requestFingerprint === requestFingerprint
            ? { outcome: "EXISTING" as const, job: toView(existing) }
            : { outcome: "IDEMPOTENCY_CONFLICT" as const };
        }
        const job = await tx.pipelineJob.create({
          data: {
            id: input.id,
            projectId: input.projectId,
            sourceId: lockedGate.source.id,
            type: "HORIZONTAL_CUT",
            sourceVersion: lockedGate.source.sourceVersion,
            sourceSha256: lockedGate.source.sha256,
            startMs: input.startMs,
            endMs: input.endMs,
            recipeVersion: CUT_RECIPE_VERSION,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint,
            maxAttempts: input.maxAttempts,
            nextAttemptAt: input.now,
            admissionDeadlineAt: input.admissionDeadlineAt,
          },
          include: { winningArtifact: true },
        });
        return { outcome: "CREATED" as const, job: toView(job) };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.pipelineJob.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        include: { winningArtifact: true },
      });
      if (!existing) throw error;
      const fingerprint = cutFingerprint({
        projectId: input.projectId,
        sourceId: existing.sourceId,
        sourceVersion: existing.sourceVersion,
        sourceSha256: existing.sourceSha256,
        startMs: input.startMs,
        endMs: input.endMs,
      });
      return existing.requestFingerprint === fingerprint
        ? { outcome: "EXISTING", job: toView(existing) }
        : { outcome: "IDEMPOTENCY_CONFLICT" };
    }
  }

  async get(projectId: string, jobId: string): Promise<CutJobReadResult> {
    const gate = await this.sourceGate(this.db, projectId);
    if (gate.outcome !== "CLEARED") return gate;
    const job = await this.db.pipelineJob.findFirst({
      where: {
        id: jobId,
        projectId,
        sourceId: gate.source.id,
        sourceVersion: gate.source.sourceVersion,
        sourceSha256: gate.source.sha256,
      },
      include: { winningArtifact: true },
    });
    return job
      ? { outcome: "FOUND", job: toView(job) }
      : { outcome: "CUT_JOB_NOT_FOUND" };
  }

  async list(projectId: string, limit: number, cursor: PageCursor | null) {
    const gate = await this.sourceGate(this.db, projectId);
    if (gate.outcome !== "CLEARED") return gate;
    const rows = await this.db.pipelineJob.findMany({
      where: {
        projectId,
        sourceId: gate.source.id,
        sourceVersion: gate.source.sourceVersion,
        sourceSha256: gate.source.sha256,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { winningArtifact: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    return { outcome: "FOUND" as const, jobs: rows.map(toView) };
  }

  async getAuthorizedSourceMedia(
    projectId: string,
  ): Promise<AuthorizedMediaResult> {
    const gate = await this.sourceGate(this.db, projectId);
    if (gate.outcome !== "CLEARED") return gate;
    const artifact = gate.source.artifacts[0];
    if (!artifact) return { outcome: "SOURCE_NOT_READY" };
    return {
      outcome: "READY",
      media: {
        objectKey: artifact.objectKey,
        sizeBytes: artifact.sizeBytes,
        contentType: artifact.contentType,
        filename: gate.source.originalFilename,
      },
    };
  }

  async getReadyDownload(projectId: string, jobId: string) {
    const read = await this.get(projectId, jobId);
    if (read.outcome !== "FOUND") return read;
    if (read.job.state !== "SUCCEEDED" || !read.job.artifact)
      return { outcome: "CUT_NOT_READY" as const };
    const artifact = await this.db.mediaArtifact.findUnique({
      where: { id: read.job.artifact.id },
    });
    if (!artifact || artifact.status !== "READY")
      return { outcome: "CUT_NOT_READY" as const };
    return {
      outcome: "READY" as const,
      media: {
        objectKey: artifact.objectKey,
        sizeBytes: artifact.sizeBytes,
        contentType: artifact.contentType,
        filename: `cut-${read.job.id}.mp4`,
      },
    };
  }

  async getAdmission(jobId: string) {
    const job = await this.db.pipelineJob.findFirst({
      where: {
        id: jobId,
        state: { in: ["QUEUED", "FAILED_RETRYABLE"] },
      },
      select: {
        startMs: true,
        endMs: true,
        source: { select: { sizeBytes: true } },
      },
    });
    return job
      ? {
          sourceSizeBytes: job.source.sizeBytes,
          requestedDurationMs: job.endMs - job.startMs,
        }
      : null;
  }

  async claim(input: {
    jobId: string;
    attemptId: string;
    leaseToken: string;
    now: Date;
    leaseMs: number;
    reservedScratchBytes: bigint;
    scratchCapacityBytes: bigint;
    heavyConcurrency: number;
  }): Promise<ClaimCutResult> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(741001)`;
      await tx.$queryRaw`SELECT "id" FROM "PipelineJob" WHERE "id" = ${input.jobId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT source."id" FROM "VideoSource" source INNER JOIN "PipelineJob" job ON job."sourceId" = source."id" WHERE job."id" = ${input.jobId}::uuid FOR SHARE OF source`;
      await tx.$queryRaw`SELECT auth."sourceId" FROM "SourceAuthorization" auth INNER JOIN "PipelineJob" job ON job."sourceId" = auth."sourceId" AND job."sourceVersion" = auth."sourceVersion" WHERE job."id" = ${input.jobId}::uuid FOR SHARE OF auth`;
      const job = await tx.pipelineJob.findUnique({
        where: { id: input.jobId },
        include: {
          winningArtifact: true,
          source: {
            include: {
              authorizations: true,
              artifacts: {
                where: { role: "SOURCE", status: "READY" },
                take: 1,
              },
            },
          },
        },
      });
      if (
        !job ||
        !["QUEUED", "FAILED_RETRYABLE"].includes(job.state) ||
        job.nextAttemptAt > input.now
      )
        return { outcome: "NOT_RUNNABLE" };
      const authorization = job.source.authorizations.find(
        (row) =>
          row.sourceVersion === job.sourceVersion &&
          row.sourceSha256 === job.sourceSha256 &&
          row.status === "CLEARED",
      );
      if (
        job.source.status !== "READY" ||
        job.source.sourceVersion !== job.sourceVersion ||
        job.source.sha256 !== job.sourceSha256 ||
        !authorization
      ) {
        await tx.pipelineJob.update({
          where: { id: job.id },
          data: {
            state: "FAILED_FINAL",
            stage: "FAILED",
            failureCode: "SOURCE_NOT_AUTHORIZED",
            failureMessage: "The exact source version is not authorized.",
            queueReason: null,
            revision: { increment: 1 },
          },
        });
        return { outcome: "SOURCE_NOT_AUTHORIZED" };
      }
      if (job.attemptCount >= job.maxAttempts) {
        await tx.pipelineJob.update({
          where: { id: job.id },
          data: {
            state: "FAILED_FINAL",
            stage: "FAILED",
            failureCode: job.failureCode ?? "RETRY_EXHAUSTED",
            failureMessage:
              job.failureMessage ?? "The retry budget was exhausted.",
            queueReason: null,
            revision: { increment: 1 },
          },
        });
        return { outcome: "ATTEMPTS_EXHAUSTED" };
      }
      const active = await tx.pipelineJob.count({
        where: { state: "RUNNING" },
      });
      if (active >= input.heavyConcurrency) return { outcome: "NO_SLOT" };
      const reserved = await tx.jobAttempt.aggregate({
        where: { state: "RUNNING", leaseExpiresAt: { gt: input.now } },
        _sum: { reservedScratchBytes: true },
      });
      if (
        (reserved._sum.reservedScratchBytes ?? 0n) +
          input.reservedScratchBytes >
        input.scratchCapacityBytes
      )
        return { outcome: "NO_CAPACITY" };
      const sourceArtifact = job.source.artifacts[0];
      if (!sourceArtifact) return { outcome: "NOT_RUNNABLE" };
      const attemptNumber = job.attemptCount + 1;
      const claimRevision = job.revision + 1;
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      await tx.jobAttempt.create({
        data: {
          id: input.attemptId,
          jobId: job.id,
          attemptNumber,
          claimRevision,
          leaseToken: input.leaseToken,
          heartbeatAt: input.now,
          leaseExpiresAt,
          reservedScratchBytes: input.reservedScratchBytes,
        },
      });
      const updated = await tx.pipelineJob.updateMany({
        where: { id: job.id, state: job.state, revision: job.revision },
        data: {
          state: "RUNNING",
          stage: "CLAIMED",
          attemptCount: attemptNumber,
          currentAttemptId: input.attemptId,
          queueReason: null,
          failureCode: null,
          failureMessage: null,
          revision: claimRevision,
        },
      });
      if (updated.count !== 1) throw new Error("CUT_CLAIM_CAS_LOST");
      return {
        outcome: "CLAIMED",
        claim: {
          job: toView({
            ...job,
            state: "RUNNING",
            attemptCount: attemptNumber,
            revision: claimRevision,
          }),
          attemptId: input.attemptId,
          attemptNumber,
          leaseToken: input.leaseToken,
          claimRevision,
          leaseExpiresAt,
          source: {
            objectKey: sourceArtifact.objectKey,
            sizeBytes: sourceArtifact.sizeBytes,
            contentType: sourceArtifact.contentType,
          },
        },
      };
    });
  }

  async heartbeat(
    lease: ActiveLease,
    now: Date,
    leaseMs: number,
  ): Promise<boolean> {
    const expires = new Date(now.getTime() + leaseMs);
    const updated = await this.db.jobAttempt.updateMany({
      where: {
        id: lease.attemptId,
        jobId: lease.jobId,
        leaseToken: lease.leaseToken,
        claimRevision: lease.claimRevision,
        state: "RUNNING",
        leaseExpiresAt: { gt: now },
        job: {
          state: "RUNNING",
          revision: lease.claimRevision,
          currentAttemptId: lease.attemptId,
        },
      },
      data: { heartbeatAt: now, leaseExpiresAt: expires },
    });
    return updated.count === 1;
  }

  async recordProgress(
    lease: ActiveLease,
    stage: string,
    current: bigint,
    total: bigint,
    unit: "BYTES" | "MILLISECONDS",
    now: Date,
  ): Promise<boolean> {
    const allowedPriorStages = progressPriorStages(stage);
    const updated = await this.db.pipelineJob.updateMany({
      where: {
        id: lease.jobId,
        state: "RUNNING",
        revision: lease.claimRevision,
        currentAttemptId: lease.attemptId,
        attempts: {
          some: {
            id: lease.attemptId,
            leaseToken: lease.leaseToken,
            state: "RUNNING",
            leaseExpiresAt: { gt: now },
          },
        },
        OR: [
          { stage: { in: allowedPriorStages } },
          { stage, progressCurrent: null },
          { stage, progressCurrent: { lte: current } },
        ],
      },
      data: {
        stage,
        progressCurrent: current > total ? total : current,
        progressTotal: total,
        progressUnit: unit,
      },
    });
    if (updated.count === 1) return true;
    const active = await this.db.jobAttempt.count({
      where: {
        id: lease.attemptId,
        jobId: lease.jobId,
        leaseToken: lease.leaseToken,
        claimRevision: lease.claimRevision,
        state: "RUNNING",
        leaseExpiresAt: { gt: now },
        job: {
          state: "RUNNING",
          revision: lease.claimRevision,
          currentAttemptId: lease.attemptId,
        },
      },
    });
    return active === 1;
  }

  async persistOutputIntent(
    lease: ActiveLease,
    objectKey: string,
    now: Date,
  ): Promise<boolean> {
    const updated = await this.db.jobAttempt.updateMany({
      where: {
        id: lease.attemptId,
        jobId: lease.jobId,
        leaseToken: lease.leaseToken,
        claimRevision: lease.claimRevision,
        state: "RUNNING",
        leaseExpiresAt: { gt: now },
        job: {
          state: "RUNNING",
          revision: lease.claimRevision,
          currentAttemptId: lease.attemptId,
        },
      },
      data: {
        outputObjectKey: objectKey,
        outputCleanupStatus: "PENDING",
        outputCleanupRequestedAt: now,
      },
    });
    return updated.count === 1;
  }

  async complete(
    lease: ActiveLease,
    artifact: CompletedArtifact,
    now: Date,
  ): Promise<boolean> {
    return this.db
      .$transaction(async (tx) => {
        const attempt = await tx.jobAttempt.findFirst({
          where: {
            id: lease.attemptId,
            jobId: lease.jobId,
            leaseToken: lease.leaseToken,
            claimRevision: lease.claimRevision,
            state: "RUNNING",
            leaseExpiresAt: { gt: now },
            outputObjectKey: artifact.objectKey,
            job: {
              state: "RUNNING",
              revision: lease.claimRevision,
              currentAttemptId: lease.attemptId,
            },
          },
          include: { job: true },
        });
        if (!attempt) return false;
        await tx.mediaArtifact.create({
          data: {
            id: artifact.id,
            projectId: attempt.job.projectId,
            sourceId: attempt.job.sourceId,
            role: "HORIZONTAL_CUT",
            status: "READY",
            objectKey: artifact.objectKey,
            storageEtag: artifact.storageEtag,
            storageVersion: artifact.storageVersion,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            contentType: artifact.contentType,
            lineageSourceId: attempt.job.sourceId,
            lineageSourceVersion: attempt.job.sourceVersion,
            recipeVersion: attempt.job.recipeVersion,
          },
        });
        const updated = await tx.pipelineJob.updateMany({
          where: {
            id: lease.jobId,
            state: "RUNNING",
            revision: lease.claimRevision,
            currentAttemptId: lease.attemptId,
            winningArtifactId: null,
          },
          data: {
            state: "SUCCEEDED",
            stage: "COMPLETED",
            winningArtifactId: artifact.id,
            progressCurrent: null,
            progressTotal: null,
            progressUnit: null,
            queueReason: null,
            failureCode: null,
            failureMessage: null,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new Error("CUT_COMPLETE_CAS_LOST");
        await tx.jobAttempt.update({
          where: { id: lease.attemptId },
          data: {
            state: "SUCCEEDED",
            finishedAt: now,
            outputCleanupStatus: "NOT_REQUIRED",
            outputCleanupRequestedAt: null,
          },
        });
        return true;
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "CUT_COMPLETE_CAS_LOST")
          return false;
        throw error;
      });
  }

  async fail(
    lease: ActiveLease,
    input: {
      retryable: boolean;
      code: string;
      message: string;
      now: Date;
      retryDelayMs: number;
    },
  ): Promise<boolean> {
    return this.db
      .$transaction(async (tx) => {
        const attempt = await tx.jobAttempt.findFirst({
          where: {
            id: lease.attemptId,
            jobId: lease.jobId,
            leaseToken: lease.leaseToken,
            claimRevision: lease.claimRevision,
            state: "RUNNING",
            leaseExpiresAt: { gt: input.now },
            job: {
              state: "RUNNING",
              revision: lease.claimRevision,
              currentAttemptId: lease.attemptId,
            },
          },
          include: { job: true },
        });
        if (!attempt) return false;
        const willRetry =
          input.retryable && attempt.job.attemptCount < attempt.job.maxAttempts;
        await tx.jobAttempt.update({
          where: { id: attempt.id },
          data: {
            state: willRetry ? "FAILED_RETRYABLE" : "FAILED_FINAL",
            finishedAt: input.now,
            failureCode: input.code,
            failureMessage: input.message,
          },
        });
        const updated = await tx.pipelineJob.updateMany({
          where: {
            id: lease.jobId,
            state: "RUNNING",
            revision: lease.claimRevision,
            currentAttemptId: lease.attemptId,
          },
          data: {
            state: willRetry ? "FAILED_RETRYABLE" : "FAILED_FINAL",
            stage: willRetry ? "RETRY_WAIT" : "FAILED",
            currentAttemptId: null,
            nextAttemptAt: new Date(input.now.getTime() + input.retryDelayMs),
            failureCode: input.code,
            failureMessage: input.message,
            progressCurrent: null,
            progressTotal: null,
            progressUnit: null,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new Error("CUT_FAIL_CAS_LOST");
        return true;
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "CUT_FAIL_CAS_LOST")
          return false;
        throw error;
      });
  }

  async markScratchWait(
    jobId: string,
    now: Date,
  ): Promise<"WAITING" | "DEADLINE" | "NOT_RUNNABLE"> {
    const job = await this.db.pipelineJob.findUnique({ where: { id: jobId } });
    if (!job || !["QUEUED", "FAILED_RETRYABLE"].includes(job.state))
      return "NOT_RUNNABLE";
    if (job.admissionDeadlineAt <= now) {
      const failed = await this.failWithoutAttempt(
        jobId,
        "SCRATCH_ADMISSION_TIMEOUT",
        "Scratch capacity was not available before the admission deadline.",
      );
      return failed ? "DEADLINE" : "NOT_RUNNABLE";
    }
    await this.db.pipelineJob.updateMany({
      where: { id: jobId, state: job.state, revision: job.revision },
      data: {
        state: "QUEUED",
        stage: "ADMISSION",
        queueReason: "SCRATCH_CAPACITY",
        revision: { increment: 1 },
      },
    });
    return "WAITING";
  }

  async failWithoutAttempt(
    jobId: string,
    code: string,
    message: string,
  ): Promise<boolean> {
    const updated = await this.db.pipelineJob.updateMany({
      where: { id: jobId, state: { in: ["QUEUED", "FAILED_RETRYABLE"] } },
      data: {
        state: "FAILED_FINAL",
        stage: "FAILED",
        queueReason: null,
        failureCode: code,
        failureMessage: message,
        revision: { increment: 1 },
      },
    });
    return updated.count === 1;
  }

  async reconcileExpired(now: Date): Promise<string[]> {
    const expired = await this.db.jobAttempt.findMany({
      where: {
        state: "RUNNING",
        leaseExpiresAt: { lte: now },
        job: { state: "RUNNING" },
      },
      select: {
        id: true,
        jobId: true,
        claimRevision: true,
        job: { select: { attemptCount: true, maxAttempts: true } },
      },
      take: 100,
    });
    const runnable: string[] = [];
    for (const row of expired) {
      const recovered = await this.db.$transaction(async (tx) => {
        const attempt = await tx.jobAttempt.updateMany({
          where: { id: row.id, state: "RUNNING", leaseExpiresAt: { lte: now } },
          data: {
            state: "ABANDONED",
            finishedAt: now,
            failureCode: "LEASE_EXPIRED",
            failureMessage: "The worker lease expired.",
          },
        });
        if (attempt.count !== 1) return false;
        const canRetry = row.job.attemptCount < row.job.maxAttempts;
        const job = await tx.pipelineJob.updateMany({
          where: {
            id: row.jobId,
            state: "RUNNING",
            revision: row.claimRevision,
            currentAttemptId: row.id,
          },
          data: {
            state: canRetry ? "FAILED_RETRYABLE" : "FAILED_FINAL",
            stage: canRetry ? "RETRY_WAIT" : "FAILED",
            currentAttemptId: null,
            nextAttemptAt: new Date(
              now.getTime() + retryDelay(row.job.attemptCount),
            ),
            failureCode: "LEASE_EXPIRED",
            failureMessage: "The worker lease expired.",
            revision: { increment: 1 },
          },
        });
        return job.count === 1 && canRetry;
      });
      if (recovered) runnable.push(row.jobId);
    }
    return runnable;
  }

  async findRunnable(now: Date, limit: number): Promise<string[]> {
    const jobs = await this.db.pipelineJob.findMany({
      where: {
        state: { in: ["QUEUED", "FAILED_RETRYABLE"] },
        nextAttemptAt: { lte: now },
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: limit,
      select: { id: true },
    });
    return jobs.map((job) => job.id);
  }

  async findPendingOutputCleanup(
    limit: number,
  ): Promise<PendingOutputCleanup[]> {
    const rows = await this.db.jobAttempt.findMany({
      where: {
        outputCleanupStatus: "PENDING",
        outputObjectKey: { not: null },
        state: { in: ["FAILED_RETRYABLE", "FAILED_FINAL", "ABANDONED"] },
      },
      orderBy: { outputCleanupRequestedAt: "asc" },
      take: limit,
      select: {
        id: true,
        jobId: true,
        attemptNumber: true,
        outputObjectKey: true,
      },
    });
    return rows.flatMap((row) =>
      row.outputObjectKey
        ? [
            {
              attemptId: row.id,
              jobId: row.jobId,
              attemptNumber: row.attemptNumber,
              objectKey: row.outputObjectKey,
            },
          ]
        : [],
    );
  }

  async findScratchCleanupAttemptIds(
    candidateIds: string[],
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const attempts = await this.db.jobAttempt.findMany({
      where: {
        id: { in: candidateIds },
        state: {
          in: ["FAILED_RETRYABLE", "FAILED_FINAL", "ABANDONED", "SUCCEEDED"],
        },
      },
      select: { id: true },
    });
    return attempts.map((attempt) => attempt.id);
  }

  async completeOutputCleanup(attemptId: string, now: Date): Promise<void> {
    await this.db.jobAttempt.updateMany({
      where: { id: attemptId, outputCleanupStatus: "PENDING" },
      data: {
        outputCleanupStatus: "COMPLETED",
        outputCleanupCompletedAt: now,
        outputCleanupLastError: null,
      },
    });
  }

  async failOutputCleanup(attemptId: string, safeCode: string): Promise<void> {
    await this.db.jobAttempt.updateMany({
      where: { id: attemptId, outputCleanupStatus: "PENDING" },
      data: {
        outputCleanupAttempts: { increment: 1 },
        outputCleanupLastError: safeCode,
      },
    });
  }

  private async sourceGate(
    tx: Transaction | PrismaClient,
    projectId: string,
  ): Promise<
    | {
        outcome: "CLEARED";
        source: NonNullable<Awaited<ReturnType<typeof sourceForProject>>>;
      }
    | {
        outcome:
          "PROJECT_NOT_FOUND" | "SOURCE_NOT_READY" | "SOURCE_NOT_AUTHORIZED";
      }
  > {
    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) return { outcome: "PROJECT_NOT_FOUND" };
    const source = await sourceForProject(tx, projectId);
    if (!source || source.status !== "READY")
      return { outcome: "SOURCE_NOT_READY" };
    const cleared = source.authorizations.some(
      (row) =>
        row.sourceVersion === source.sourceVersion &&
        row.sourceSha256 === source.sha256 &&
        row.status === "CLEARED",
    );
    return cleared
      ? { outcome: "CLEARED", source }
      : { outcome: "SOURCE_NOT_AUTHORIZED" };
  }
}

async function sourceForProject(
  tx: Transaction | PrismaClient,
  projectId: string,
) {
  return tx.videoSource.findUnique({
    where: { projectId },
    include: {
      authorizations: true,
      artifacts: { where: { role: "SOURCE", status: "READY" }, take: 1 },
    },
  });
}

function toView(row: JobWithArtifact): CutJobView {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    sourceSha256: row.sourceSha256,
    startMs: row.startMs,
    endMs: row.endMs,
    recipeVersion: CUT_RECIPE_VERSION,
    state: row.state,
    stage: row.stage,
    progress:
      row.progressCurrent !== null &&
      row.progressTotal !== null &&
      (row.progressUnit === "BYTES" || row.progressUnit === "MILLISECONDS")
        ? {
            current: row.progressCurrent,
            total: row.progressTotal,
            unit: row.progressUnit,
          }
        : null,
    attempts: row.attemptCount,
    queueReason: row.queueReason,
    admissionDeadlineAt: row.admissionDeadlineAt,
    failure:
      row.failureCode && row.failureMessage
        ? { code: row.failureCode, message: row.failureMessage }
        : null,
    revision: row.revision,
    artifact: row.winningArtifact
      ? {
          id: row.winningArtifact.id,
          sizeBytes: row.winningArtifact.sizeBytes,
          sha256: row.winningArtifact.sha256,
          contentType: row.winningArtifact.contentType,
        }
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function retryDelay(attemptNumber: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attemptNumber - 1));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function cutFingerprint(input: {
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceSha256: string;
  startMs: number;
  endMs: number;
}): string {
  return JSON.stringify({
    projectId: input.projectId,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    sourceSha256: input.sourceSha256,
    startMs: input.startMs,
    endMs: input.endMs,
    type: "HORIZONTAL_CUT",
    recipeVersion: CUT_RECIPE_VERSION,
  });
}

function progressPriorStages(stage: string): string[] {
  if (stage === "SOURCE_DOWNLOAD") return ["CLAIMED"];
  if (stage === "ENCODING") return ["CLAIMED", "SOURCE_DOWNLOAD"];
  if (stage === "OUTPUT_UPLOAD")
    return ["CLAIMED", "SOURCE_DOWNLOAD", "ENCODING"];
  return [];
}
