import { randomUUID } from "node:crypto";

import { PrismaCutJobRepository } from "@content-factory/manual-cut";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/database/prisma.service.js";

describe("manual cut PostgreSQL state machine", () => {
  let prisma: PrismaService;
  let jobs: PrismaCutJobRepository;
  let projectId: string;
  let sourceId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    projectId = randomUUID();
    sourceId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        idempotencyKey: `cut-test-project-${randomUUID()}`,
        requestFingerprint: "cut-test",
        name: "Cut repository test",
        status: "SOURCE_READY",
        source: {
          create: {
            id: sourceId,
            status: "READY",
            sourceVersion: 1,
            originalFilename: "source.mp4",
            contentType: "video/mp4",
            sizeBytes: 1_000n,
            sha256: "a".repeat(64),
            authorizations: {
              create: {
                sourceVersion: 1,
                sourceSha256: "a".repeat(64),
                status: "CLEARED",
                basis: "EXPLICIT_CONFIRMATION",
                confirmedAt: new Date(),
                declarationVersion: "source-rights-v1",
              },
            },
          },
        },
        artifacts: {
          create: {
            id: randomUUID(),
            sourceId,
            role: "SOURCE",
            status: "READY",
            objectKey: `cut-test/${projectId}/source.mp4`,
            sizeBytes: 1_000n,
            sha256: "a".repeat(64),
            contentType: "video/mp4",
            lineageSourceId: sourceId,
            lineageSourceVersion: 1,
            recipeVersion: "source-ingest-v1",
          },
        },
      },
    });
    jobs = new PrismaCutJobRepository(prisma);
  });

  afterEach(async () => {
    await prisma.pipelineJob.deleteMany({ where: { projectId } });
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.$disconnect();
  });

  it("persists one idempotent intent and gives one duplicate delivery the lease", async () => {
    const now = new Date();
    const input = createInput(now, "repository-idempotency");
    const first = await jobs.create(input);
    const second = await jobs.create({ ...input, id: randomUUID() });
    expect(first.outcome).toBe("CREATED");
    expect(second.outcome).toBe("EXISTING");
    if (first.outcome !== "CREATED") throw new Error("expected created");
    if (second.outcome !== "EXISTING") throw new Error("expected existing");
    expect(second.job.id).toBe(first.job.id);
    await expect(
      jobs.create({ ...input, id: randomUUID(), endMs: 2_001 }),
    ).resolves.toEqual({ outcome: "IDEMPOTENCY_CONFLICT" });

    const claims = await Promise.all([
      jobs.claim(claimInput(first.job.id, now, 600n, 2_000n)),
      jobs.claim(claimInput(first.job.id, now, 600n, 2_000n)),
    ]);
    expect(claims.filter((claim) => claim.outcome === "CLAIMED")).toHaveLength(
      1,
    );
    expect(
      await prisma.jobAttempt.count({ where: { jobId: first.job.id } }),
    ).toBe(1);
  });

  it("atomically bounds scratch reservations and recovers an expired lease", async () => {
    const now = new Date();
    const first = await jobs.create(createInput(now, "capacity-first"));
    const second = await jobs.create(createInput(now, "capacity-second"));
    if (first.outcome !== "CREATED" || second.outcome !== "CREATED")
      throw new Error("expected jobs");
    const firstClaim = await jobs.claim(
      claimInput(first.job.id, now, 600n, 1_000n),
    );
    expect(firstClaim.outcome).toBe("CLAIMED");
    await expect(
      jobs.claim(claimInput(second.job.id, now, 600n, 1_000n)),
    ).resolves.toEqual({ outcome: "NO_CAPACITY" });

    const later = new Date(now.getTime() + 1_001);
    await expect(jobs.reconcileExpired(later)).resolves.toEqual([first.job.id]);
    await expect(
      prisma.jobAttempt.findFirstOrThrow({ where: { jobId: first.job.id } }),
    ).resolves.toMatchObject({ state: "ABANDONED" });
    await expect(
      prisma.pipelineJob.findUniqueOrThrow({ where: { id: first.job.id } }),
    ).resolves.toMatchObject({
      state: "FAILED_RETRYABLE",
      currentAttemptId: null,
    });
  });

  it("treats stale progress as benign and never exposes live upload intent to cleanup", async () => {
    const now = new Date();
    const created = await jobs.create(createInput(now, "progress-cleanup"));
    if (created.outcome !== "CREATED") throw new Error("expected job");
    const result = await jobs.claim(
      claimInput(created.job.id, now, 100n, 1_000n),
    );
    if (result.outcome !== "CLAIMED") throw new Error("expected claim");
    const lease = {
      jobId: created.job.id,
      attemptId: result.claim.attemptId,
      leaseToken: result.claim.leaseToken,
      claimRevision: result.claim.claimRevision,
    };
    await expect(
      jobs.recordProgress(lease, "ENCODING", 900n, 1_000n, "MILLISECONDS", now),
    ).resolves.toBe(true);
    await expect(
      jobs.recordProgress(lease, "ENCODING", 400n, 1_000n, "MILLISECONDS", now),
    ).resolves.toBe(true);
    await expect(
      prisma.pipelineJob.findUniqueOrThrow({ where: { id: created.job.id } }),
    ).resolves.toMatchObject({ progressCurrent: 900n });
    await expect(
      jobs.persistOutputIntent(
        lease,
        `cut-test/${created.job.id}/attempt.mp4`,
        now,
      ),
    ).resolves.toBe(true);
    await expect(jobs.findPendingOutputCleanup(10)).resolves.toEqual([]);
    await expect(
      jobs.fail(lease, {
        retryable: false,
        code: "INVALID_SOURCE_MEDIA",
        message: "Invalid media.",
        now,
        retryDelayMs: 0,
      }),
    ).resolves.toBe(true);
    await expect(jobs.findPendingOutputCleanup(10)).resolves.toEqual([
      {
        attemptId: result.claim.attemptId,
        jobId: created.job.id,
        attemptNumber: 1,
        objectKey: `cut-test/${created.job.id}/attempt.mp4`,
      },
    ]);
  });

  it("rechecks exact source authorization while claiming", async () => {
    const now = new Date();
    const created = await jobs.create(createInput(now, "claim-authorization"));
    if (created.outcome !== "CREATED") throw new Error("expected job");
    await prisma.sourceAuthorization.update({
      where: { sourceId_sourceVersion: { sourceId, sourceVersion: 1 } },
      data: {
        status: "NOT_REVIEWED",
        basis: null,
        confirmedAt: null,
        declarationVersion: null,
      },
    });
    try {
      await expect(
        jobs.claim(claimInput(created.job.id, now, 100n, 1_000n)),
      ).resolves.toEqual({ outcome: "SOURCE_NOT_AUTHORIZED" });
      await expect(
        prisma.jobAttempt.count({ where: { jobId: created.job.id } }),
      ).resolves.toBe(0);
      await expect(
        prisma.pipelineJob.findUniqueOrThrow({ where: { id: created.job.id } }),
      ).resolves.toMatchObject({
        state: "FAILED_FINAL",
        failureCode: "SOURCE_NOT_AUTHORIZED",
      });
    } finally {
      await prisma.sourceAuthorization.update({
        where: { sourceId_sourceVersion: { sourceId, sourceVersion: 1 } },
        data: {
          status: "CLEARED",
          basis: "EXPLICIT_CONFIRMATION",
          confirmedAt: new Date(),
          declarationVersion: "source-rights-v1",
        },
      });
    }
  });

  it("exhausts the retry budget at exactly maxAttempts", async () => {
    const now = new Date();
    const created = await jobs.create(createInput(now, "retry-exhaustion"));
    if (created.outcome !== "CREATED") throw new Error("expected job");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await jobs.claim(
        claimInput(created.job.id, now, 100n, 1_000n),
      );
      if (result.outcome !== "CLAIMED") throw new Error("expected claim");
      await expect(
        jobs.fail(leaseFor(created.job.id, result.claim), {
          retryable: true,
          code: "MEDIA_TIMEOUT",
          message: "Media runtime timed out.",
          now,
          retryDelayMs: 0,
        }),
      ).resolves.toBe(true);
      await expect(
        prisma.pipelineJob.findUniqueOrThrow({ where: { id: created.job.id } }),
      ).resolves.toMatchObject({
        state: attempt < 3 ? "FAILED_RETRYABLE" : "FAILED_FINAL",
        attemptCount: attempt,
      });
    }
  });

  it("rejects a lease-lost finalizer and keeps one winning artifact", async () => {
    const now = new Date();
    const created = await jobs.create(createInput(now, "lease-finalize"));
    if (created.outcome !== "CREATED") throw new Error("expected job");
    const first = await jobs.claim(
      claimInput(created.job.id, now, 100n, 1_000n),
    );
    if (first.outcome !== "CLAIMED") throw new Error("expected first claim");
    const firstLease = leaseFor(created.job.id, first.claim);
    const firstKey = `cut-test/${created.job.id}/first.mp4`;
    await expect(
      jobs.persistOutputIntent(firstLease, firstKey, now),
    ).resolves.toBe(true);

    await expect(
      jobs.reconcileExpired(new Date(now.getTime() + 1_001)),
    ).resolves.toEqual([created.job.id]);
    const retryAt = new Date(now.getTime() + 2_002);
    const second = await jobs.claim(
      claimInput(created.job.id, retryAt, 100n, 1_000n),
    );
    if (second.outcome !== "CLAIMED") throw new Error("expected retry claim");
    const secondLease = leaseFor(created.job.id, second.claim);
    const secondKey = `cut-test/${created.job.id}/second.mp4`;
    await expect(
      jobs.persistOutputIntent(secondLease, secondKey, retryAt),
    ).resolves.toBe(true);
    const winningId = randomUUID();
    await expect(
      jobs.complete(secondLease, artifact(winningId, secondKey), retryAt),
    ).resolves.toBe(true);
    await expect(
      jobs.complete(firstLease, artifact(randomUUID(), firstKey), retryAt),
    ).resolves.toBe(false);
    await expect(
      prisma.mediaArtifact.count({
        where: { projectId, role: "HORIZONTAL_CUT" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.pipelineJob.findUniqueOrThrow({ where: { id: created.job.id } }),
    ).resolves.toMatchObject({
      state: "SUCCEEDED",
      winningArtifactId: winningId,
      attemptCount: 2,
    });
  });

  it("rolls back an artifact when final job CAS persistence fails", async () => {
    const now = new Date();
    const created = await jobs.create(createInput(now, "complete-rollback"));
    if (created.outcome !== "CREATED") throw new Error("expected job");
    const result = await jobs.claim(
      claimInput(created.job.id, now, 100n, 1_000n),
    );
    if (result.outcome !== "CLAIMED") throw new Error("expected claim");
    const lease = leaseFor(created.job.id, result.claim);
    const objectKey = `cut-test/${created.job.id}/rollback.mp4`;
    await jobs.persistOutputIntent(lease, objectKey, now);
    const artifactId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `cut_fail_${suffix}`;
    const triggerName = `cut_fail_trigger_${suffix}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."id" = '${created.job.id}'::uuid AND NEW."state" = 'SUCCEEDED' THEN
          RAISE EXCEPTION 'forced cut finalize failure';
        END IF;
        RETURN NEW;
      END $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON "PipelineJob"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      await expect(
        jobs.complete(lease, artifact(artifactId, objectKey), now),
      ).rejects.toThrow();
      await expect(
        prisma.mediaArtifact.count({ where: { id: artifactId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.pipelineJob.findUniqueOrThrow({ where: { id: created.job.id } }),
      ).resolves.toMatchObject({ state: "RUNNING", winningArtifactId: null });
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON "PipelineJob"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${functionName}"()`,
      );
    }
  });

  function createInput(now: Date, key: string) {
    return {
      id: randomUUID(),
      projectId,
      idempotencyKey: key,
      startMs: 1_000,
      endMs: 2_000,
      now,
      admissionDeadlineAt: new Date(now.getTime() + 900_000),
      maxAttempts: 3,
    };
  }
});

function leaseFor(
  jobId: string,
  claim: {
    attemptId: string;
    leaseToken: string;
    claimRevision: number;
  },
) {
  return {
    jobId,
    attemptId: claim.attemptId,
    leaseToken: claim.leaseToken,
    claimRevision: claim.claimRevision,
  };
}

function artifact(id: string, objectKey: string) {
  return {
    id,
    objectKey,
    sizeBytes: 123n,
    sha256: "b".repeat(64),
    contentType: "video/mp4",
  };
}

function claimInput(
  jobId: string,
  now: Date,
  reservedScratchBytes: bigint,
  scratchCapacityBytes: bigint,
) {
  return {
    jobId,
    attemptId: randomUUID(),
    leaseToken: randomUUID(),
    now,
    leaseMs: 1_000,
    reservedScratchBytes,
    scratchCapacityBytes,
    heavyConcurrency: 2,
  };
}
