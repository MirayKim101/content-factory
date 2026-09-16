import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  FrameContextCapture,
  FrameMeasurement,
} from "@content-factory/contracts";
import { databaseUrl } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AiContentIdempotencyConflictError } from "../src/ai-content/application/creator-context-repository.port.js";
import { PrismaFrameEvidenceRepository } from "../src/ai-content/infrastructure/prisma-frame-evidence.repository.js";
import { PrismaPipelineRepository } from "../src/media-pipeline/infrastructure/prisma-pipeline.repository.js";
import {
  clearFrameFixtures,
  seedFrameContext,
} from "./fixtures/frame-evidence-fixture.js";

interface Plan {
  intentId: string;
  jobId: string;
  capture: FrameContextCapture;
  inputObjectKey: string;
  contextPolicyFingerprint: string;
}
interface Work extends Plan {
  attemptId: string;
  attemptNumber: number;
  leaseToken: string;
  workDeadlineAt: Date;
  scratchDirectoryName: string;
  scratchReservedBytes: number;
}
interface Output {
  id: string;
  ordinal: number;
  objectKey: string;
}
interface WorkerRepository {
  initializePool(capacity: number): Promise<void>;
  close(): Promise<void>;
  plan(jobId: string): Promise<Plan | null>;
  claim(input: Record<string, unknown>): Promise<Work | null>;
  heartbeat(work: Work, leaseMs: number): Promise<boolean>;
  admitInputRead(work: Work): Promise<void>;
  prepareOutput(work: Work, ordinal: number): Promise<Output>;
  uploadSettled(work: Work, output: Output): Promise<void>;
  uploaded(
    work: Work,
    output: Output,
    measurement: FrameMeasurement,
  ): Promise<void>;
  finalize(work: Work): Promise<void>;
  accepted(work: Work): Promise<boolean>;
  executionStopped(work: Work): Promise<void>;
  fail(
    work: Work,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<void>;
  recover(limit: number): Promise<void>;
  cleanupCandidates(
    limit: number,
  ): Promise<Array<{ outputId: string; objectKey: string }>>;
  cleaned(id: string, errorCode?: string): Promise<void>;
}

describe("frozen frame persistence and independent worker gates (disposable PostgreSQL)", () => {
  let prisma: PrismaService;
  let api: PrismaFrameEvidenceRepository;
  let worker: WorkerRepository;
  let replica: WorkerRepository;
  const projectIds: string[] = [];
  const profileIds: string[] = [];
  const oldPolicy = process.env.SOURCE_AUTHORIZATION_POLICY;
  beforeAll(async () => {
    if (process.env.POSTGRES_DB !== "cf_acceptance_20260916")
      throw new Error(
        "Explicit disposable POSTGRES_DB=cf_acceptance_20260916 required",
      );
    process.env.SOURCE_AUTHORIZATION_POLICY = "manual";
    prisma = new PrismaService();
    await prisma.$connect();
    api = new PrismaFrameEvidenceRepository(prisma);
    // Runtime import deliberately keeps worker implementation out of API's
    // production/rootDir build while exercising the real independent adapter.
    const module = (await import(
      new URL(
        "../../worker/src/infrastructure/pg-frame-job.repository.ts",
        import.meta.url,
      ).href
    )) as {
      PgFrameJobRepository: new (
        url: string,
        policy: "manual",
      ) => WorkerRepository;
    };
    worker = new module.PgFrameJobRepository(databaseUrl(), "manual");
    replica = new module.PgFrameJobRepository(databaseUrl(), "manual");
    await worker.initializePool(1);
    await replica.initializePool(1);
  });
  afterEach(async () => {
    if (prisma)
      await clearFrameFixtures(
        prisma,
        projectIds.splice(0),
        profileIds.splice(0),
      );
  });
  afterAll(async () => {
    await Promise.all([
      worker?.close(),
      replica?.close(),
      prisma?.$disconnect(),
    ]);
    if (oldPolicy === undefined) delete process.env.SOURCE_AUTHORIZATION_POLICY;
    else process.env.SOURCE_AUTHORIZATION_POLICY = oldPolicy;
  });

  async function fixture() {
    const value = await seedFrameContext(prisma);
    projectIds.push(value.projectId);
    profileIds.push(value.profileId);
    return value;
  }
  async function intent(
    f: Awaited<ReturnType<typeof fixture>>,
    key = randomUUID(),
  ) {
    const id = await api.create({
      cutPipelineJobId: f.cutJobId,
      sourceContextRevisionId: f.contextRevisionId,
      cutPromptRevisionId: f.promptRevisionId,
      idempotencyKey: key,
    });
    const view = (await api.detail(id))!;
    return { id, view, plan: (await worker.plan(view.pipelineJobId))! };
  }
  async function claim(plan: Plan, repository = worker) {
    return repository.claim({
      plan,
      workerId: randomUUID(),
      leaseMs: 30_000,
      workDeadlineMs: 300_000,
      scratchDirectoryName: `content-factory-frames-${randomUUID()}-abc123`,
      scratchReservedBytes: 100_000_000,
      availableScratchBytes: 10_000_000_000,
    });
  }
  function measurement(ordinal: number): FrameMeasurement {
    const requested = [750, 1500, 2250][ordinal]!;
    return {
      ordinal,
      requestedCutMs: requested,
      requestedSourceMs: 1000 + requested,
      actualPtsTicks: requested * 1000,
      timeBaseNumerator: 1,
      timeBaseDenominator: 1000000,
      actualCutMs: requested,
      mappedSourceMs: 1000 + requested,
      width: 320,
      height: 240,
      sizeBytes: 1024,
      sha256: String(ordinal + 1).repeat(64),
      contentType: "image/jpeg",
      recipeVersion: "quartiles-jpeg-640-v1",
      extractorVersion: "ffmpeg-frame-extractor-v1",
      ffmpegVersion: "ffmpeg version 5.1.9",
    };
  }
  async function outputs(work: Work) {
    const result: Output[] = [];
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      const output = await worker.prepareOutput(work, ordinal);
      await worker.uploadSettled(work, output);
      await worker.uploaded(work, output, measurement(ordinal));
      result.push(output);
    }
    return result;
  }

  it("shares module-wide durable idempotency, including concurrent replay and other-operation conflict", async () => {
    const f = await fixture();
    const key = randomUUID();
    const [first, second] = await Promise.all([intent(f, key), intent(f, key)]);
    expect(first.id).toBe(second.id);
    expect(
      await prisma.frameEvidenceIntent.count({
        where: { projectId: f.projectId },
      }),
    ).toBe(1);
    const conflicting = randomUUID();
    await prisma.aiContentOperationRequest.create({
      data: {
        id: randomUUID(),
        idempotencyKey: conflicting,
        operation: "CREATE_CREATOR_PROFILE",
        canonicalRequestFingerprint: "c".repeat(64),
        resultType: "CREATOR_PROFILE",
        resultId: f.profileId,
        resolvedProjectId: f.projectId,
        resolvedSourceId: f.sourceId,
        resolvedSourceVersion: 1,
      },
    });
    await expect(intent(f, conflicting)).rejects.toBeInstanceOf(
      AiContentIdempotencyConflictError,
    );
    await expect(
      api.create({
        cutPipelineJobId: f.cutJobId,
        sourceContextRevisionId: randomUUID(),
        cutPromptRevisionId: f.promptRevisionId,
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(AiContentIdempotencyConflictError);
  });

  it("enforces one global slot across replicas, immutable lease identity and no attempt on deferral", async () => {
    const f = await fixture();
    const one = await intent(f);
    const two = await intent(f);
    const claims = await Promise.all([
      claim(one.plan),
      claim(two.plan, replica),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const work = claims.find(Boolean)!;
    const deferred = claims[0] ? two : one;
    const job = await prisma.pipelineJob.findUniqueOrThrow({
      where: { id: deferred.plan.jobId },
    });
    expect(job.attemptCount).toBe(0);
    expect(job.admissionReason).toBe("FRAME_RESOURCE_BUSY");
    expect(job.nextAttemptAt).not.toBeNull();
    await expect(
      prisma.frameExtractionSlot.updateMany({
        where: { attemptId: work.attemptId },
        data: { leaseToken: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.frameEvidenceAttempt.update({
        where: { id: work.attemptId },
        data: { leaseToken: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(replica.initializePool(2)).rejects.toThrow(
      "FRAME_CAPACITY_CONFIGURATION_MISMATCH",
    );
    expect(await worker.heartbeat(work, 30_000)).toBe(true);
    const attempt = await prisma.frameEvidenceAttempt.findUniqueOrThrow({
      where: { id: work.attemptId },
    });
    expect(attempt.workDeadlineAt).toEqual(work.workDeadlineAt);
    const slot = await prisma.frameExtractionSlot.findFirstOrThrow({
      where: { attemptId: work.attemptId },
    });
    const owner = await prisma.pipelineJob.findUniqueOrThrow({
      where: { id: work.jobId },
    });
    expect(slot.leaseExpiresAt).toEqual(owner.leaseExpiresAt);
  });

  it("generic expired-lease recovery cannot bypass the frame deadline and slot grace", async () => {
    const f = await fixture();
    const value = await intent(f);
    const work = (await claim(value.plan))!;
    await prisma.pipelineJob.update({
      where: { id: work.jobId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await new PrismaPipelineRepository(prisma).recoverExpiredLeases(100);
    await worker.recover(100);
    expect(
      (
        await prisma.pipelineJob.findUniqueOrThrow({
          where: { id: work.jobId },
        })
      ).state,
    ).toBe("PROCESSING");
    expect(
      await prisma.frameExtractionSlot.count({
        where: { attemptId: work.attemptId },
      }),
    ).toBe(1);
    expect(await worker.heartbeat(work, 30_000)).toBe(false);
  });

  it("pre-read gate records exact fingerprint and denies a profile edit committed first", async () => {
    const f = await fixture();
    const value = await intent(f);
    const work = (await claim(value.plan))!;
    await prisma.creatorProfile.update({
      where: { id: f.profileId },
      data: { currentRevision: 2 },
    });
    await expect(worker.admitInputRead(work)).rejects.toMatchObject({
      code: "FRAME_CONTEXT_STALE",
    });
    expect(
      (
        await prisma.frameEvidenceAttempt.findUniqueOrThrow({
          where: { id: work.attemptId },
        })
      ).inputReadStartedAt,
    ).toBeNull();
    await prisma.creatorProfile.update({
      where: { id: f.profileId },
      data: { currentRevision: 1 },
    });
    await worker.admitInputRead(work);
    const attempt = await prisma.frameEvidenceAttempt.findUniqueOrThrow({
      where: { id: work.attemptId },
    });
    expect(attempt.inputReadStartedAt).not.toBeNull();
    expect(attempt.inputReadFingerprint).toBe(work.contextPolicyFingerprint);
  });

  it("serializes admission against an upstream current-row writer and retries its stale snapshot", async () => {
    const f = await fixture();
    let release!: () => void;
    let locked!: () => void;
    const releaseWriter = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writerLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const mutation = prisma.$transaction(async (tx) => {
      await tx.creatorProfile.update({
        where: { id: f.profileId },
        data: { currentRevision: 2 },
      });
      locked();
      await releaseWriter;
    });
    await writerLocked;
    let completed = false;
    const admission = intent(f)
      .then(
        () => ({ accepted: true, error: undefined }),
        (error: unknown) => ({ accepted: false, error }),
      )
      .finally(() => {
        completed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(false);
    release();
    await mutation;
    const result = await admission;
    expect(result.accepted).toBe(false);
    expect(result.error).toMatchObject({
      message: "FRAME_CONTEXT_REQUIRED",
      blockers: ["CREATOR_PROFILE_REVISION_STALE"],
    });
    expect(
      await prisma.frameEvidenceIntent.count({
        where: { projectId: f.projectId },
      }),
    ).toBe(0);
  });

  it("a rights change after the admitted read blocks atomic finalization without partial acceptance", async () => {
    const f = await fixture();
    const value = await intent(f);
    const work = (await claim(value.plan))!;
    await worker.admitInputRead(work);
    await outputs(work);
    await prisma.sourceAuthorization.update({
      where: {
        sourceId_sourceVersion: { sourceId: f.sourceId, sourceVersion: 1 },
      },
      data: { revision: 2 },
    });
    await expect(worker.finalize(work)).rejects.toMatchObject({
      code: "FRAME_CONTEXT_STALE",
    });
    expect(
      await prisma.frameEvidenceResult.count({ where: { intentId: value.id } }),
    ).toBe(0);
    expect(
      await prisma.frameEvidenceFrame.count({ where: { intentId: value.id } }),
    ).toBe(0);
    expect(await worker.cleanupCandidates(50)).toEqual([]);
    expect(
      (
        await prisma.frameEvidenceAttempt.findUniqueOrThrow({
          where: { id: work.attemptId },
        })
      ).inputReadStartedAt,
    ).not.toBeNull();
  });

  it("deadline recovery waits for30second grace then terminates with finishedAt; fenced early stop may retry", async () => {
    const f = await fixture();
    const value = await intent(f);
    const work = (await claim(value.plan))!;
    await prisma.pipelineJob.update({
      where: { id: work.jobId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await prisma.frameEvidenceAttempt.update({
      where: { id: work.attemptId },
      data: {
        createdAt: new Date(Date.now() - 120_000),
        workDeadlineAt: new Date(Date.now() - 20_000),
      },
    });
    await worker.recover(50);
    expect(
      (
        await prisma.pipelineJob.findUniqueOrThrow({
          where: { id: work.jobId },
        })
      ).state,
    ).toBe("PROCESSING");
    expect(
      await prisma.frameExtractionSlot.count({
        where: { attemptId: work.attemptId },
      }),
    ).toBe(1);
    await prisma.frameEvidenceAttempt.update({
      where: { id: work.attemptId },
      data: { workDeadlineAt: new Date(Date.now() - 31_000) },
    });
    await worker.recover(50);
    const terminal = await prisma.pipelineJob.findUniqueOrThrow({
      where: { id: work.jobId },
    });
    expect(terminal.state).toBe("FAILED_FINAL");
    expect(terminal.failureCode).toBe("FRAME_WORK_DEADLINE_EXCEEDED");
    expect(terminal.finishedAt).not.toBeNull();
    expect(terminal.nextAttemptAt).toBeNull();
    expect(
      await prisma.frameExtractionSlot.count({
        where: { attemptId: work.attemptId },
      }),
    ).toBe(0);

    const next = await intent(f);
    const early = (await claim(next.plan))!;
    await worker.executionStopped(early);
    await worker.recover(50);
    const retry = await prisma.pipelineJob.findUniqueOrThrow({
      where: { id: early.jobId },
    });
    expect(retry.state).toBe("RETRY_WAIT");
    expect(retry.failureCode).toBe("JOB_LEASE_LOST");
    expect(retry.finishedAt).toBeNull();
    expect(retry.nextAttemptAt).not.toBeNull();
    expect(
      (
        await prisma.frameEvidenceAttempt.findUniqueOrThrow({
          where: { id: early.attemptId },
        })
      ).workDeadlineAt,
    ).toEqual(early.workDeadlineAt);
    expect((await claim(next.plan))!.attemptNumber).toBe(2);
  });

  it("commits exactly3 frames once, preserves accepted outputs and separates stale metadata from rights", async () => {
    const f = await fixture();
    const value = await intent(f);
    const work = (await claim(value.plan))!;
    await worker.admitInputRead(work);
    const prepared = await outputs(work);
    await worker.finalize(work);
    await worker.executionStopped(work);
    expect(await worker.accepted(work)).toBe(true);
    await expect(worker.finalize(work)).rejects.toMatchObject({
      code: "JOB_LEASE_LOST",
    });
    let view = (await api.detail(value.id))!;
    expect(view.job.state).toBe("READY");
    expect(view.frames).toHaveLength(3);
    expect(view.currentUse.usableForGeneration).toBe(true);
    expect(await worker.cleanupCandidates(50)).toEqual([]);
    await expect(
      prisma.frameEvidenceAttemptOutput.update({
        where: { id: prepared[0]!.id },
        data: { objectKey: "source/private-other-object" },
      }),
    ).rejects.toThrow();
    await prisma.creatorProfile.update({
      where: { id: f.profileId },
      data: { currentRevision: 2 },
    });
    view = (await api.detail(value.id))!;
    expect(view.currentUse.usableForGeneration).toBe(false);
    expect(view.contentAccess.bytesReadable).toBe(true);
    expect(await api.content(value.id, view.frames[0]!.id)).not.toBeNull();
    await prisma.sourceAuthorization.update({
      where: {
        sourceId_sourceVersion: { sourceId: f.sourceId, sourceVersion: 1 },
      },
      data: {
        status: "NOT_REVIEWED",
        revision: 2,
        basis: null,
        declarationVersion: null,
        decidedAt: null,
      },
    });
    await expect(api.content(value.id, view.frames[0]!.id)).rejects.toThrow(
      "SOURCE_AUTHORIZATION_REQUIRED",
    );
    await prisma.sourceAuthorization.update({
      where: {
        sourceId_sourceVersion: { sourceId: f.sourceId, sourceVersion: 1 },
      },
      data: {
        status: "CLEARED",
        revision: 3,
        basis: "OPERATOR_ATTESTATION",
        declarationVersion: "source-rights-v1",
        decidedAt: new Date(),
      },
    });
    expect((await api.detail(value.id))!.contentAccess.bytesReadable).toBe(
      true,
    );
    expect((await api.detail(value.id))!.currentUse.usableForGeneration).toBe(
      false,
    );
  });

  it("fails closed for partial READY and rejects measured PTS beyond the exact3second cut", async () => {
    const f = await fixture();
    const value = await intent(f);
    const work = (await claim(value.plan))!;
    await worker.admitInputRead(work);
    const prepared = await outputs(work);
    const invalid = {
      ...measurement(2),
      actualPtsTicks: 4_000_000,
      actualCutMs: 4000,
      mappedSourceMs: 5000,
    };
    await prisma.frameEvidenceAttemptOutput.update({
      where: { id: prepared[2]!.id },
      data: { measurement: invalid },
    });
    await expect(worker.finalize(work)).rejects.toMatchObject({
      code: "FRAME_OUTPUT_SET_INVALID",
    });
    expect(
      await prisma.frameEvidenceResult.count({ where: { intentId: value.id } }),
    ).toBe(0);
    await prisma.pipelineJob.update({
      where: { id: work.jobId },
      data: { state: "READY" },
    });
    const view = (await api.detail(value.id))!;
    expect(view.job.state).toBe("FAILED_FINAL");
    expect(view.job.failure?.code).toBe("FRAME_RESULT_INCOMPLETE");
    expect(view.currentUse.usableForGeneration).toBe(false);
    expect(view.frames).toEqual([]);
  });

  it("retains unknown-upload cleanup tombstones after delete, catching a late losing PutObject", async () => {
    const f = await fixture();
    const value = await intent(f);
    const work = (await claim(value.plan))!;
    const output = await worker.prepareOutput(work, 0);
    await worker.fail(work, "UPLOAD_UNKNOWN", "fixture", true);
    expect(await worker.cleanupCandidates(50)).toEqual([]);
    await worker.executionStopped(work);
    const objects = new Set<string>();
    let candidates = await worker.cleanupCandidates(50);
    expect(candidates).toEqual([
      { outputId: output.id, objectKey: output.objectKey },
    ]);
    objects.delete(output.objectKey);
    await worker.cleaned(output.id);
    let row = await prisma.frameEvidenceAttemptOutput.findUniqueOrThrow({
      where: { id: output.id },
    });
    expect(row.cleanupStatus).toBe("PENDING");
    expect(row.cleanupLastErrorCode).toBe("FRAME_UPLOAD_OUTCOME_UNKNOWN");
    expect(await worker.cleanupCandidates(50)).toEqual([]);
    objects.add(output.objectKey); // Remote completion arrived after the first delete.
    await worker.uploadSettled(work, output);
    await prisma.frameEvidenceAttemptOutput.update({
      where: { id: output.id },
      data: { nextCleanupAt: new Date(0) },
    });
    candidates = await worker.cleanupCandidates(50);
    for (const candidate of candidates) {
      objects.delete(candidate.objectKey);
      await worker.cleaned(candidate.outputId);
    }
    row = await prisma.frameEvidenceAttemptOutput.findUniqueOrThrow({
      where: { id: output.id },
    });
    expect(objects.size).toBe(0);
    expect(row.cleanupStatus).toBe("COMPLETED");
  });

  it("rejects Frankenstein profile/context/prompt captures at the database boundary", async () => {
    const one = await fixture();
    const two = await fixture();
    const value = await intent(one);
    const sourceContext =
      await prisma.sourceEditorialContextRevision.findUniqueOrThrow({
        where: { id: one.contextRevisionId },
      });
    const alternateContextRevisionId = randomUUID();
    await prisma.sourceEditorialContextRevision.create({
      data: {
        ...sourceContext,
        id: alternateContextRevisionId,
        revision: 2,
        restrictions: [],
        creatorProfileId: two.profileId,
        creatorProfileRevisionId: two.profileRevisionId,
        creatorProfileRevisionNo: 1,
      },
    });
    await expect(
      prisma.frameEvidenceIntent.update({
        where: { id: value.id },
        data: {
          sourceContextRevisionId: alternateContextRevisionId,
          sourceContextRevisionNo: 2,
          creatorProfileId: two.profileId,
          creatorProfileRevisionId: two.profileRevisionId,
          creatorProfileRevisionNo: 1,
        },
      }),
    ).rejects.toThrow();
  });
});
