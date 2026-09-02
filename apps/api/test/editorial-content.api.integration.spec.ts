import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { apiEnvironment } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import {
  EDITORIAL_STORAGE,
  type EditorialStorage,
} from "../src/editorial-content/application/editorial-storage.port.js";
import { ReconcileEditorialAssets } from "../src/editorial-content/application/reconcile-editorial-assets.js";
import { png } from "./fixtures/thumbnail-fixture.js";

describe("Stage 2 manual editorial draft API (PostgreSQL)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: EditorialStorage;
  const projectIds: string[] = [];
  const integrationPrefix = `editorial-integration-${randomUUID()}`;
  const integrationKey = (name: string): string =>
    `${integrationPrefix}-${name}`;

  beforeAll(async () => {
    process.env.MEDIA_QUEUE_DISABLED = "1";
    const { createApp } = await import("../src/main.js");
    app = await createApp();
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
    storage = app.get(EDITORIAL_STORAGE);
  });

  afterEach(async () => {
    const objects = await prisma.editorialAsset.findMany({
      where: { projectId: { in: projectIds } },
      select: { objectKey: true },
    });
    await Promise.all(
      objects.map(({ objectKey }) => storage.deleteObject(objectKey)),
    );
    await prisma.editorialMutationRequest.deleteMany({
      where: {
        packageRevision: { package: { projectId: { in: projectIds } } },
      },
    });
    await prisma.editorialPackageRevision.deleteMany({
      where: { package: { projectId: { in: projectIds } } },
    });
    await prisma.editorialPackage.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.editorialAsset.deleteMany({
      where: { projectId: { in: projectIds } },
    });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    projectIds.splice(0);
    await prisma.processingTemplateRevision.deleteMany({
      where: {
        template: {
          idempotencyKey: { startsWith: `${integrationPrefix}-` },
        },
      },
    });
    await prisma.processingTemplate.deleteMany({
      where: { idempotencyKey: { startsWith: `${integrationPrefix}-` } },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("uses one exact template revision for two READY cuts and reloads immutable drafts", async () => {
    const template = await createTemplate(integrationKey("template-01"));
    const first = await readyCut();
    const second = await readyCut();
    const firstThumbnail = await readyThumbnail(first.projectId);
    const secondThumbnail = await readyThumbnail(second.projectId);
    const jobsBefore = await prisma.pipelineJob.count();
    const firstRequest = {
      expectedRevision: 0,
      processingTemplateRevisionId: template.id,
      title: "First cut",
      description: "First description",
      tags: ["ordered-first", "ordered-second"],
      thumbnailAssetId: firstThumbnail,
    };
    const firstDraft = await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("package-01"))
      .send(firstRequest)
      .expect(200);
    const secondDraft = await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${second.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("package-02"))
      .send({
        ...firstRequest,
        title: "Second cut",
        thumbnailAssetId: secondThumbnail,
      })
      .expect(200);

    expect(firstDraft.body.validation).toEqual({
      complete: true,
      missingFields: [],
    });
    expect(firstDraft.body.revision.tags).toEqual([
      "ordered-first",
      "ordered-second",
    ]);
    expect(firstDraft.body.revision.processingTemplateRevision.id).toBe(
      template.id,
    );
    expect(secondDraft.body.revision.processingTemplateRevision.id).toBe(
      template.id,
    );
    expect(firstDraft.body.cutResultArtifact).toMatchObject({
      id: first.artifactId,
      sha256: first.sha256,
    });

    const replay = await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("package-01"))
      .send(firstRequest)
      .expect(200);
    expect(replay.body).toEqual(firstDraft.body);

    const secondRevision = await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("package-update"))
      .send({
        ...firstRequest,
        expectedRevision: 1,
        description: "Revised description",
      })
      .expect(200);
    expect(secondRevision.body.revision).toMatchObject({
      revision: 2,
      description: "Revised description",
    });
    const immutableRevisions = await prisma.editorialPackageRevision.findMany({
      where: { package: { pipelineJobId: first.jobId } },
      orderBy: { revision: "asc" },
      select: { revision: true, description: true },
    });
    expect(immutableRevisions).toEqual([
      { revision: 1, description: "First description" },
      { revision: 2, description: "Revised description" },
    ]);

    const concurrentBody = {
      ...firstRequest,
      expectedRevision: 2,
      description: "Concurrent idempotent revision",
    };
    const [concurrentFirst, concurrentReplay] = await Promise.all([
      request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
        .set("Idempotency-Key", integrationKey("concurrent-same"))
        .send(concurrentBody),
      request(app.getHttpServer())
        .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
        .set("Idempotency-Key", integrationKey("concurrent-same"))
        .send(concurrentBody),
    ]);
    expect(concurrentFirst.status).toBe(200);
    expect(concurrentReplay.status).toBe(200);
    expect(concurrentReplay.body.revision).toEqual(
      concurrentFirst.body.revision,
    );
    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("concurrent-same"))
      .send({ ...concurrentBody, title: "Different body" })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT"),
      );

    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("package-stale"))
      .send({ ...firstRequest, expectedRevision: 2, title: "Lost update" })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("EDITORIAL_REVISION_CONFLICT"),
      );
    const reloaded = await request(app.getHttpServer())
      .get(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .expect(200);
    expect(reloaded.body).toEqual(concurrentFirst.body);

    const packages = await request(app.getHttpServer())
      .get(`/api/v1/projects/${first.projectId}/editorial-packages`)
      .expect(200);
    expect(packages.body.items).toEqual([concurrentFirst.body]);
    expect(await prisma.pipelineJob.count()).toBe(jobsBefore);
    const unchangedArtifact = await prisma.mediaArtifact.findUniqueOrThrow({
      where: { id: first.artifactId },
    });
    expect(unchangedArtifact.sha256).toBe(first.sha256);
    await prisma.mediaArtifact.update({
      where: { id: first.artifactId },
      data: { recipeVersion: "tampered-recipe" },
    });
    await request(app.getHttpServer())
      .get(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("CUT_RESULT_LINEAGE_INVALID"),
      );
  });

  it("uploads, lists, streams, replays, and restart-cleans private thumbnail objects", async () => {
    const cut = await readyCut();
    const bytes = png(1280, 720);
    const uploaded = await request(app.getHttpServer())
      .post(`/api/v1/projects/${cut.projectId}/editorial-assets/thumbnails`)
      .set("Idempotency-Key", integrationKey("multipart"))
      .attach("file", bytes, {
        filename: "cover.png",
        contentType: "image/png",
      })
      .expect(201);
    expect(uploaded.body).toMatchObject({
      projectId: cut.projectId,
      status: "READY",
      contentType: "image/png",
      width: 1280,
      height: 720,
    });
    expect(uploaded.body).not.toHaveProperty("objectKey");
    const uploadedRow = await prisma.editorialAsset.findUniqueOrThrow({
      where: { id: uploaded.body.id as string },
      select: { objectKey: true },
    });
    const config = apiEnvironment();
    const directResponse = await fetch(
      `${config.s3Endpoint}/${config.sourceBucket}/${uploadedRow.objectKey}`,
    );
    expect(directResponse.status).toBe(403);

    const replay = await request(app.getHttpServer())
      .post(`/api/v1/projects/${cut.projectId}/editorial-assets/thumbnails`)
      .set("Idempotency-Key", integrationKey("multipart"))
      .attach("file", bytes, {
        filename: "cover.png",
        contentType: "image/png",
      })
      .expect(201);
    expect(replay.body).toEqual(uploaded.body);
    await request(app.getHttpServer())
      .post(`/api/v1/projects/${cut.projectId}/editorial-assets/thumbnails`)
      .set("Idempotency-Key", integrationKey("multipart"))
      .attach("file", bytes, {
        filename: "different-name.png",
        contentType: "image/png",
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT"),
      );

    await request(app.getHttpServer())
      .get(`/api/v1/projects/${cut.projectId}/editorial-assets/thumbnails`)
      .expect(200)
      .expect(({ body }) => expect(body.items).toEqual([uploaded.body]));
    await request(app.getHttpServer())
      .get(
        `/api/v1/projects/${cut.projectId}/editorial-assets/thumbnails/${uploaded.body.id}/content`,
      )
      .expect("Content-Type", /image\/png/)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual(bytes));

    const failedId = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), "editorial-recovery-"));
    const path = join(directory, "orphan.png");
    await writeFile(path, bytes);
    const objectKey = `editorial/${cut.projectId}/thumbnails/${failedId}/original`;
    try {
      await storage.putFile({
        objectKey,
        filePath: path,
        contentType: "image/png",
        sha256: "d".repeat(64),
      });
      await prisma.editorialAsset.create({
        data: {
          id: failedId,
          projectId: cut.projectId,
          type: "THUMBNAIL",
          status: "FAILED_FINAL",
          idempotencyKey: `editorial-cleanup-${failedId}`,
          requestFingerprint: "integration",
          objectKey,
          cleanupStatus: "PENDING",
          cleanupRequestedAt: new Date(),
          failureCode: "THUMBNAIL_FINALIZE_FAILED",
          failureMessage: "Thumbnail finalization failed.",
          originalFilename: "orphan.png",
          contentType: "image/png",
          sizeBytes: BigInt(bytes.length),
          sha256: "d".repeat(64),
          width: 1280,
          height: 720,
        },
      });
      await app.get(ReconcileEditorialAssets).execute();
      await expect(storage.headObject(objectKey)).resolves.toBeNull();
      await expect(
        prisma.editorialAsset.findUniqueOrThrow({ where: { id: failedId } }),
      ).resolves.toMatchObject({ cleanupStatus: "COMPLETED" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for exact-version authorization on save, get, and project list", async () => {
    const template = await createTemplate(integrationKey("template-auth"));
    const cut = await readyCut(false);
    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${cut.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("auth-save"))
      .send({ expectedRevision: 0, processingTemplateRevisionId: template.id })
      .expect(403)
      .expect(({ body }) =>
        expect(body.error.code).toBe("SOURCE_AUTHORIZATION_REQUIRED"),
      );
    await request(app.getHttpServer())
      .get(`/api/v1/pipeline-jobs/${cut.jobId}/editorial-package`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/projects/${cut.projectId}/editorial-packages`)
      .expect(403);
    expect(
      await prisma.editorialPackage.count({
        where: { pipelineJobId: cut.jobId },
      }),
    ).toBe(0);
  });

  it("reports incomplete fields and rejects cross-project, non-ready, and invalid lineage", async () => {
    const template = await createTemplate(integrationKey("template-02"));
    const first = await readyCut();
    const second = await readyCut();
    const otherThumbnail = await readyThumbnail(second.projectId);

    const incomplete = await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("incomplete"))
      .send({
        expectedRevision: 0,
        processingTemplateRevisionId: template.id,
        title: "",
        description: null,
        tags: [],
      })
      .expect(200);
    expect(incomplete.body.validation).toEqual({
      complete: false,
      missingFields: ["TITLE", "DESCRIPTION", "TAGS", "THUMBNAIL"],
    });

    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${first.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("cross-project"))
      .send({
        expectedRevision: 1,
        processingTemplateRevisionId: template.id,
        thumbnailAssetId: otherThumbnail,
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("THUMBNAIL_PROJECT_MISMATCH"),
      );

    await prisma.pipelineJob.update({
      where: { id: second.jobId },
      data: { state: "PROCESSING" },
    });
    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${second.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("not-ready"))
      .send({ expectedRevision: 0, processingTemplateRevisionId: template.id })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("CUT_RESULT_NOT_READY"),
      );

    await prisma.pipelineJob.update({
      where: { id: second.jobId },
      data: { state: "READY" },
    });
    await prisma.mediaArtifact.update({
      where: { id: second.artifactId },
      data: { recipeVersion: "wrong-recipe" },
    });
    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${second.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("wrong-recipe"))
      .send({ expectedRevision: 0, processingTemplateRevisionId: template.id })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("CUT_RESULT_LINEAGE_INVALID"),
      );
    await prisma.mediaArtifact.update({
      where: { id: second.artifactId },
      data: { recipeVersion: "stage1-cut-h264-v2", sha256: "invalid" },
    });
    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${second.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("invalid-checksum"))
      .send({ expectedRevision: 0, processingTemplateRevisionId: template.id })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("CUT_RESULT_LINEAGE_INVALID"),
      );
    await prisma.mediaArtifact.update({
      where: { id: second.artifactId },
      data: { lineageSourceVersion: 2, sha256: "b".repeat(64) },
    });
    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${second.jobId}/editorial-package`)
      .set("Idempotency-Key", integrationKey("wrong-lineage"))
      .send({ expectedRevision: 0, processingTemplateRevisionId: template.id })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("CUT_RESULT_LINEAGE_INVALID"),
      );
  });

  async function createTemplate(idempotencyKey: string) {
    const response = await request(app.getHttpServer())
      .post("/api/v1/processing-templates")
      .set("Idempotency-Key", idempotencyKey)
      .send({ name: "Horizontal manual package" })
      .expect(201);
    return response.body as { id: string };
  }

  async function readyCut(authorized = true): Promise<{
    projectId: string;
    jobId: string;
    artifactId: string;
    sha256: string;
  }> {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const sourceArtifactId = randomUUID();
    const jobId = randomUUID();
    const artifactId = randomUUID();
    const sha256 = "b".repeat(64);
    projectIds.push(projectId);
    await prisma.$transaction(async (transaction) => {
      await transaction.project.create({
        data: {
          id: projectId,
          idempotencyKey: `editorial-project-${projectId}`,
          requestFingerprint: "integration",
          name: "Editorial integration project",
          status: "SOURCE_READY",
        },
      });
      await transaction.videoSource.create({
        data: {
          id: sourceId,
          projectId,
          status: "READY",
          sourceVersion: 1,
          originalFilename: "source.mp4",
          contentType: "video/mp4",
          sizeBytes: 1000n,
          sha256: "a".repeat(64),
          durationMs: 30_000,
        },
      });
      await transaction.sourceAuthorization.create({
        data: {
          sourceId,
          sourceVersion: 1,
          status: authorized ? "CLEARED" : "NOT_REVIEWED",
          ...(authorized
            ? {
                basis: "OPERATOR_ATTESTATION" as const,
                declarationVersion: "source-authorization-v1",
                decidedAt: new Date(),
              }
            : {}),
        },
      });
      await transaction.mediaArtifact.create({
        data: {
          id: sourceArtifactId,
          projectId,
          sourceId,
          role: "SOURCE",
          status: "READY",
          objectKey: `sources/${projectId}/${sourceId}/v1/source.mp4`,
          sizeBytes: 1000n,
          sha256: "a".repeat(64),
          contentType: "video/mp4",
          lineageSourceId: sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "source-ingest-v1",
        },
      });
      await transaction.pipelineJob.create({
        data: {
          id: jobId,
          projectId,
          sourceId,
          sourceVersion: 1,
          type: "CUT_SEGMENT",
          state: "READY",
          idempotencyKey: `editorial-job-${jobId}`,
          recipeVersion: "stage1-cut-h264-v2",
        },
      });
      await transaction.mediaArtifact.create({
        data: {
          id: artifactId,
          projectId,
          sourceId,
          role: "CUT_RESULT",
          status: "READY",
          objectKey: `sources/${projectId}/results/${jobId}/integration.mp4`,
          sizeBytes: 500n,
          sha256,
          contentType: "video/mp4",
          lineageSourceId: sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "stage1-cut-h264-v2",
          pipelineJobId: jobId,
        },
      });
    });
    return { projectId, jobId, artifactId, sha256 };
  }

  async function readyThumbnail(projectId: string): Promise<string> {
    const id = randomUUID();
    await prisma.editorialAsset.create({
      data: {
        id,
        projectId,
        type: "THUMBNAIL",
        status: "READY",
        idempotencyKey: `editorial-thumbnail-${id}`,
        requestFingerprint: "integration",
        objectKey: `editorial/${projectId}/thumbnails/${id}/original`,
        originalFilename: "thumbnail.png",
        contentType: "image/png",
        sizeBytes: 100n,
        sha256: "c".repeat(64),
        width: 1280,
        height: 720,
      },
    });
    return id;
  }
});
