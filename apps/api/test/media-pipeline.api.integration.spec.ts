import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/database/prisma.service.js";
import {
  JOB_DISPATCH,
  type JobDispatch,
} from "../src/media-pipeline/application/job-dispatch.port.js";
import { MEDIA_QUEUE } from "../src/media-pipeline/infrastructure/bullmq-job-dispatch.js";
import { PrismaPipelineRepository } from "../src/media-pipeline/infrastructure/prisma-pipeline.repository.js";

describe("Stage 1 cut intent API (PostgreSQL + BullMQ)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue | null;
  let dispatch: JobDispatch;
  let repository: PrismaPipelineRepository;
  const projects: string[] = [];
  const previousMediaQueueName = process.env.MEDIA_QUEUE_NAME;
  const integrationQueueName = `media-v1-integration-${process.pid}-${randomUUID()}`;

  beforeAll(async () => {
    process.env.MEDIA_QUEUE_NAME = integrationQueueName;
    const { createApp } = await import("../src/main.js");
    app = await createApp();
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
    queue = app.get(MEDIA_QUEUE);
    dispatch = app.get(JOB_DISPATCH);
    repository = app.get(PrismaPipelineRepository);
    await queue?.obliterate({ force: true });
  });

  afterEach(async () => {
    for (const id of projects.splice(0)) {
      await prisma.project.deleteMany({ where: { id } });
    }
  });

  afterAll(async () => {
    try {
      await queue?.obliterate({ force: true });
      await app.close();
    } finally {
      if (previousMediaQueueName === undefined) {
        delete process.env.MEDIA_QUEUE_NAME;
      } else {
        process.env.MEDIA_QUEUE_NAME = previousMediaQueueName;
      }
    }
  });

  it("atomically creates independent jobs and first attempts, then replays idempotently", async () => {
    const projectId = await readyProject(120_000);
    const segments = [
      { clientSegmentId: randomUUID(), startMs: 1_000, endMs: 4_000 },
      { clientSegmentId: randomUUID(), startMs: 10_000, endMs: 14_500 },
    ];
    const first = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/cuts`)
      .set("Idempotency-Key", "integration-cuts-0001")
      .send({ segments })
      .expect(201);

    expect(first.body.jobs).toHaveLength(2);
    for (const job of first.body.jobs as Array<{ id: string }>) {
      await expect(queue?.getJob(`${job.id}-attempt-1`)).resolves.toBeTruthy();
    }
    expect(
      first.body.jobs.map((job: { startMs: number; endMs: number }) => [
        job.startMs,
        job.endMs,
      ]),
    ).toEqual([
      [1_000, 4_000],
      [10_000, 14_500],
    ]);
    const persisted = await prisma.pipelineJob.findMany({
      where: { cutRequestId: first.body.requestId as string },
      include: { segment: true, attempts: true },
    });
    expect(persisted).toHaveLength(2);
    expect(
      persisted.every(
        (job) =>
          job.attempts.length === 1 && job.attempts[0]?.state === "QUEUED",
      ),
    ).toBe(true);
    expect(new Set(persisted.map((job) => job.id)).size).toBe(2);
    expect(
      new Set(persisted.map((job) => job.segment?.clientSegmentId)).size,
    ).toBe(2);

    const replay = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/cuts`)
      .set("Idempotency-Key", "integration-cuts-0001")
      .send({ segments })
      .expect(201);
    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.cutRequest.count({
        where: { idempotencyKey: "integration-cuts-0001" },
      }),
    ).toBe(1);

    await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/cuts`)
      .set("Idempotency-Key", "integration-cuts-0001")
      .send({ segments: [{ ...segments[0], endMs: 5_000 }] })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT"),
      );
  });

  it("rejects out-of-duration bounds without persisting a job", async () => {
    const projectId = await readyProject(5_000);
    await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/cuts`)
      .set("Idempotency-Key", "integration-cuts-invalid-0001")
      .send({
        segments: [
          { clientSegmentId: randomUUID(), startMs: 1_000, endMs: 6_000 },
        ],
      })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("CUT_BOUNDS_INVALID"));
    expect(
      await prisma.pipelineJob.count({
        where: { projectId, type: "CUT_SEGMENT" },
      }),
    ).toBe(0);
  });

  it("returns a safe 416 for an unsatisfiable source range", async () => {
    const projectId = await readyProject(5_000);
    const response = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/source`)
      .set("Range", "bytes=1000-")
      .expect(416)
      .expect("Accept-Ranges", "bytes")
      .expect("Content-Range", "bytes */1000");

    expect(response.body).toEqual({
      error: {
        code: "RANGE_NOT_SATISFIABLE",
        message: "The requested byte range is not satisfiable.",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /InvalidRange|objectKey|test\/|S3/i,
    );
  });

  it("returns a safe 416 for an unsatisfiable cut-result range", async () => {
    const projectId = await readyProject(5_000);
    const source = await prisma.videoSource.findUniqueOrThrow({
      where: { projectId },
    });
    const jobId = randomUUID();
    await prisma.pipelineJob.create({
      data: {
        id: jobId,
        projectId,
        sourceId: source.id,
        type: "CUT_SEGMENT",
        state: "READY",
        idempotencyKey: `test-result-${randomUUID()}`,
        recipeVersion: "stage1-cut-h264-v1",
        attemptCount: 1,
        finishedAt: new Date(),
      },
    });
    await prisma.mediaArtifact.create({
      data: {
        id: randomUUID(),
        projectId,
        sourceId: source.id,
        pipelineJobId: jobId,
        role: "CUT_RESULT",
        status: "READY",
        objectKey: `test/${projectId}/${jobId}/result.mp4`,
        sizeBytes: 321n,
        sha256: "c".repeat(64),
        contentType: "video/mp4",
        lineageSourceId: source.id,
        lineageSourceVersion: source.sourceVersion,
        recipeVersion: "stage1-cut-h264-v1",
        ffmpegVersion: "ffmpeg test",
        outputFilename: "cut-001.mp4",
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/pipeline-jobs/${jobId}/result`)
      .set("Range", "bytes=321-999")
      .expect(416)
      .expect("Accept-Ranges", "bytes")
      .expect("Content-Range", "bytes */321");

    expect(response.body).toEqual({
      error: {
        code: "RANGE_NOT_SATISFIABLE",
        message: "The requested byte range is not satisfiable.",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /InvalidRange|objectKey|test\/|S3/i,
    );
  });

  it("recovers an expired worker lease back to a PostgreSQL-runnable state", async () => {
    const projectId = await readyProject(10_000);
    const segments = [
      { clientSegmentId: randomUUID(), startMs: 1_000, endMs: 2_000 },
    ];
    const created = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/cuts`)
      .set("Idempotency-Key", "integration-cuts-lease-0001")
      .send({ segments })
      .expect(201);
    const jobId = created.body.jobs[0].id as string;
    const leaseToken = randomUUID();
    await prisma.pipelineJob.update({
      where: { id: jobId },
      data: {
        state: "PROCESSING",
        attemptCount: 1,
        leaseOwner: "crashed-worker",
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.jobAttempt.update({
      where: { jobId_attemptNumber: { jobId, attemptNumber: 1 } },
      data: { state: "PROCESSING" },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/cuts`)
      .set("Idempotency-Key", "integration-cuts-lease-0001")
      .send({ segments })
      .expect(201);
    await expect(queue?.getJob(`${jobId}-attempt-2`)).resolves.toBeUndefined();

    await prisma.pipelineJob.update({
      where: { id: jobId },
      data: { leaseExpiresAt: new Date(Date.now() - 10_000) },
    });

    const recovered = await repository.recoverExpiredLeases(10);
    expect(recovered).toContainEqual({
      jobId,
      attemptNumber: 2,
    });
    await dispatch.dispatch({ jobId, attemptNumber: 2 });
    await expect(queue?.getJob(`${jobId}-attempt-2`)).resolves.toBeTruthy();
    expect(`${jobId}-attempt-2`).not.toBe(`${jobId}-attempt-1`);
    await expect(
      prisma.pipelineJob.findUniqueOrThrow({ where: { id: jobId } }),
    ).resolves.toMatchObject({
      state: "RETRY_WAIT",
      leaseToken: null,
    });
    await expect(
      prisma.jobAttempt.findUniqueOrThrow({
        where: { jobId_attemptNumber: { jobId, attemptNumber: 1 } },
      }),
    ).resolves.toMatchObject({
      state: "FAILED_RETRYABLE",
      failureCode: "WORKER_LEASE_EXPIRED",
    });
  });

  async function readyProject(durationMs: number): Promise<string> {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    projects.push(projectId);
    await prisma.project.create({
      data: {
        id: projectId,
        idempotencyKey: `test-${randomUUID()}`,
        requestFingerprint: "a".repeat(64),
        name: "Cut source",
        status: "SOURCE_READY",
        rightsConfirmedAt: new Date(),
        rightsDeclarationVersion: "upload-rights-v1",
        source: {
          create: {
            id: sourceId,
            status: "READY",
            sourceVersion: 1,
            originalFilename: "source.mp4",
            contentType: "video/mp4",
            sizeBytes: 1_000n,
            sha256: "b".repeat(64),
            durationMs,
            probedAt: new Date(),
            probeVersion: "ffprobe test",
          },
        },
        artifacts: {
          create: {
            id: randomUUID(),
            sourceId,
            role: "SOURCE",
            status: "READY",
            objectKey: `test/${projectId}/source.mp4`,
            sizeBytes: 1_000n,
            sha256: "b".repeat(64),
            contentType: "video/mp4",
            lineageSourceId: sourceId,
            lineageSourceVersion: 1,
            recipeVersion: "source-ingest-v1",
          },
        },
      },
    });
    return projectId;
  }
});
