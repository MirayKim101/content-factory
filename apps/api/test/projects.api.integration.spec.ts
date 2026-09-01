import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/database/prisma.service.js";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../src/projects/application/object-storage.port.js";
import { CreateProjectWithSource } from "../src/projects/application/create-project-with-source.js";
import { ReconcilePendingUploads } from "../src/projects/application/reconcile-pending-uploads.js";
import { PrismaProjectRepository } from "../src/projects/infrastructure/prisma-project.repository.js";
import { tinyMp4 } from "./fixtures/mp4-fixture.js";

describe("projects upload API (PostgreSQL + MinIO)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: ObjectStorage;
  let projects: PrismaProjectRepository;
  let reconciliation: ReconcilePendingUploads;
  let uploadDirectory: string;
  const createdProjectIds: string[] = [];

  beforeAll(async () => {
    uploadDirectory = await mkdtemp(
      join(tmpdir(), "content-factory-api-test-"),
    );
    process.env.API_UPLOAD_TEMP_DIRECTORY = uploadDirectory;
    process.env.API_MAX_UPLOAD_BYTES = "2048";
    process.env.SOURCE_PENDING_STALE_AFTER_MS = "600000";
    const { createApp } = await import("../src/main.js");
    app = await createApp();
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
    storage = app.get<ObjectStorage>(OBJECT_STORAGE);
    projects = app.get(PrismaProjectRepository);
    reconciliation = app.get(ReconcilePendingUploads);
  });

  afterEach(async () => {
    for (const projectId of createdProjectIds.splice(0)) {
      const artifact = await prisma.mediaArtifact.findFirst({
        where: { projectId, role: "SOURCE" },
        select: { objectKey: true },
      });
      if (artifact) {
        await storage.deleteObject(artifact.objectKey);
        await expect(
          storage.headObject(artifact.objectKey),
        ).resolves.toBeNull();
      }
      const deleted = await prisma.project.deleteMany({
        where: { id: projectId },
      });
      expect(deleted.count).toBe(1);
    }
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadDirectory, { recursive: true, force: true });
  });

  it("uploads an authorized MP4, persists lineage, stores the object, and supports GET", async () => {
    expect(process.env.MINIO_ROOT_USER).toBeUndefined();
    expect(process.env.MINIO_ROOT_PASSWORD).toBeUndefined();
    const created = await request(app.getHttpServer())
      .post("/api/v1/projects")
      .set("Idempotency-Key", "integration-happy-0001")
      .field("name", "Integration source")
      .field("rightsConfirmed", "true")
      .attach("file", tinyMp4(), {
        filename: "source.mp4",
        contentType: "video/mp4",
      })
      .expect(201);

    createdProjectIds.push(created.body.id as string);
    expect(created.body).toMatchObject({
      name: "Integration source",
      status: "SOURCE_READY",
      source: { status: "READY", sourceVersion: 1, contentType: "video/mp4" },
      artifact: {
        role: "SOURCE",
        status: "READY",
        recipeVersion: "source-ingest-v1",
      },
    });
    expect(created.body.source.sizeBytes).toBe(String(tinyMp4().length));
    expect(created.body).not.toHaveProperty("artifact.objectKey");
    expect(JSON.stringify(created.body)).not.toContain(uploadDirectory);

    const internalArtifact = await prisma.mediaArtifact.findFirstOrThrow({
      where: { projectId: created.body.id as string },
    });
    expect(internalArtifact.storageEtag).toBeTruthy();
    await expect(
      storage.headObject(internalArtifact.objectKey),
    ).resolves.toMatchObject({
      sizeBytes: tinyMp4().length,
      sha256: internalArtifact.sha256,
    });

    const fetched = await request(app.getHttpServer())
      .get(`/api/v1/projects/${created.body.id as string}`)
      .expect(200);
    expect(fetched.body).toEqual(created.body);
  });

  it("requires the explicit rights declaration and removes its temp file", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/projects")
      .set("Idempotency-Key", "integration-rights-0001")
      .field("name", "No rights")
      .attach("file", tinyMp4(), {
        filename: "source.mp4",
        contentType: "video/mp4",
      })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("VALIDATION_FAILED"));
    expect(await readdir(uploadDirectory)).toEqual([]);

    await request(app.getHttpServer())
      .post("/api/v1/projects")
      .field("name", "No idempotency key")
      .field("rightsConfirmed", "true")
      .attach("file", tinyMp4(), {
        filename: "source.mp4",
        contentType: "video/mp4",
      })
      .expect(400)
      .expect(({ body }) =>
        expect(body.error.code).toBe("IDEMPOTENCY_KEY_INVALID"),
      );
    expect(await readdir(uploadDirectory)).toEqual([]);
  });

  it("rejects a fake MP4 by content and cleans the temp file", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/projects")
      .set("Idempotency-Key", "integration-fake-0001")
      .field("name", "Fake")
      .field("rightsConfirmed", "true")
      .attach("file", Buffer.from("not an mp4"), {
        filename: "fake.mp4",
        contentType: "video/mp4",
      })
      .expect(415)
      .expect(({ body }) => expect(body.error.code).toBe("INVALID_MP4"));
    expect(await readdir(uploadDirectory)).toEqual([]);
  });

  it("returns a controlled 413 for oversized input", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/projects")
      .set("Idempotency-Key", "integration-large-0001")
      .field("name", "Too large")
      .field("rightsConfirmed", "true")
      .attach("file", tinyMp4(4096), {
        filename: "large.mp4",
        contentType: "video/mp4",
      })
      .expect(413)
      .expect(({ body }) => expect(body.error.code).toBe("UPLOAD_TOO_LARGE"));
    expect(await readdir(uploadDirectory)).toEqual([]);
  });

  it("returns controlled not-found and publishes the multipart OpenAPI contract", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/projects/00000000-0000-4000-8000-000000000099")
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe("PROJECT_NOT_FOUND"));

    const openApi = await request(app.getHttpServer())
      .get("/api/docs-json")
      .expect(200);
    const operation = openApi.body.paths["/api/v1/projects"].post;
    expect(operation.requestBody.content).toHaveProperty("multipart/form-data");
    expect(
      operation.responses["201"].content["application/json"].schema,
    ).toEqual({
      $ref: "#/components/schemas/ProjectResponseDto",
    });
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Idempotency-Key",
          in: "header",
          required: true,
        }),
      ]),
    );
    for (const status of ["400", "409", "413", "415", "500", "503"]) {
      expect(
        operation.responses[status].content["application/json"].schema,
      ).toEqual({
        $ref: "#/components/schemas/ErrorResponseDto",
      });
    }
    expect(
      openApi.body.paths["/api/v1/projects/{id}"].get.parameters[0].schema
        .format,
    ).toBe("uuid");
  });

  it("deduplicates concurrent matching keys and rejects conflicting reuse", async () => {
    const upload = (name: string) =>
      request(app.getHttpServer())
        .post("/api/v1/projects")
        .set("Idempotency-Key", "integration-idempotent-0001")
        .field("name", name)
        .field("rightsConfirmed", "true")
        .attach("file", tinyMp4(), {
          filename: "source.mp4",
          contentType: "video/mp4",
        });

    const [first, second] = await Promise.all([
      upload("Same source"),
      upload("Same source"),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    createdProjectIds.push(first.body.id as string);
    await expect(
      prisma.project.count({
        where: { idempotencyKey: "integration-idempotent-0001" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.mediaArtifact.count({
        where: { projectId: first.body.id as string },
      }),
    ).resolves.toBe(1);

    await request(app.getHttpServer())
      .post("/api/v1/projects")
      .set("Idempotency-Key", "integration-idempotent-0001")
      .field("name", "Same source")
      .field("rightsConfirmed", "true")
      .attach("file", tinyMp4(), {
        filename: "renamed-source.mp4",
        contentType: "video/mp4",
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT"),
      );

    await upload("Different source")
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT"),
      );
  });

  it("cleans request-scoped temp data for truncated multipart and disconnect", async () => {
    const boundary = "content-factory-truncated-boundary";
    const truncated = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nBroken\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="rightsConfirmed"\r\n\r\ntrue\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.mp4"\r\n` +
        `Content-Type: video/mp4\r\n\r\npartial`,
    );
    await request(app.getHttpServer())
      .post("/api/v1/projects")
      .set("Idempotency-Key", "integration-truncated-0001")
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(truncated)
      .expect(400);
    expect(await readdir(uploadDirectory)).toEqual([]);

    const address = app.getHttpServer().address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const uploadRequest = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/v1/projects",
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": 1_000_000,
          "idempotency-key": "integration-aborted-0001",
        },
      });
      uploadRequest.on("error", () => resolve());
      uploadRequest.write(truncated);
      setTimeout(() => {
        uploadRequest.destroy();
        resolve();
      }, 20);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(uploadDirectory)).toEqual([]);
  });

  it("uses compare-and-set terminal transitions under concurrency", async () => {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const artifactId = randomUUID();
    createdProjectIds.push(projectId);
    await projects.createPendingUpload({
      projectId,
      idempotencyKey: `cas-${randomUUID()}`,
      requestFingerprint: "a".repeat(64),
      sourceId,
      artifactId,
      name: "CAS source",
      rightsConfirmedAt: new Date(),
      rightsDeclarationVersion: "upload-rights-v1",
      originalFilename: "source.mp4",
      contentType: "video/mp4",
      sizeBytes: 100n,
      sha256: "a".repeat(64),
      sourceVersion: 1,
      objectKey: `sources/${projectId}/${sourceId}/v1/source.mp4`,
      recipeVersion: "source-ingest-v1",
    });

    const outcomes = await Promise.allSettled([
      projects.finalizeReady(artifactId, { etag: "etag" }),
      projects.markFailed(projectId, "TEST_FAILURE", "Test failure.", false),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const state = await projects.getById(projectId);
    expect(state).not.toBeNull();
    if (state?.status === "SOURCE_READY") {
      await expect(
        projects.markFailed(projectId, "TEST_FAILURE", "Test failure.", false),
      ).rejects.toThrow();
      await expect(
        projects.finalizeReady(artifactId, { etag: "etag" }),
      ).resolves.toBeUndefined();
    } else {
      await expect(
        projects.finalizeReady(artifactId, { etag: "etag" }),
      ).rejects.toThrow();
      await expect(
        projects.markFailed(projectId, "TEST_FAILURE", "Test failure.", false),
      ).resolves.toBeUndefined();
    }
  });

  it("fails integrity-mismatched recovery and persists cleanup until deletion succeeds", async () => {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const artifactId = randomUUID();
    const objectKey = `sources/${projectId}/${sourceId}/v1/source.mp4`;
    createdProjectIds.push(projectId);
    await projects.createPendingUpload({
      projectId,
      idempotencyKey: `recovery-${randomUUID()}`,
      requestFingerprint: "b".repeat(64),
      sourceId,
      artifactId,
      name: "Recovery mismatch",
      rightsConfirmedAt: new Date(),
      rightsDeclarationVersion: "upload-rights-v1",
      originalFilename: "source.mp4",
      contentType: "video/mp4",
      sizeBytes: 999n,
      sha256: "b".repeat(64),
      sourceVersion: 1,
      objectKey,
      recipeVersion: "source-ingest-v1",
    });
    const filePath = join(uploadDirectory, `recovery-${randomUUID()}`);
    await writeFile(filePath, tinyMp4());
    await storage.putFile({
      objectKey,
      filePath,
      contentType: "video/mp4",
      sha256: "c".repeat(64),
    });

    await reconciliation.execute(
      new Date(Date.now() + 1_000),
      25,
      new AbortController().signal,
    );

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    const artifact = await prisma.mediaArtifact.findUniqueOrThrow({
      where: { id: artifactId },
    });
    expect(project).toMatchObject({
      status: "FAILED_FINAL",
      failureCode: "SOURCE_OBJECT_INTEGRITY_MISMATCH",
    });
    expect(artifact.cleanupStatus).toBe("COMPLETED");
    await expect(storage.headObject(objectKey)).resolves.toBeNull();
    await rm(filePath, { force: true });
  });

  it("persists a failed cleanup attempt and retries it on the next reconciliation", async () => {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const artifactId = randomUUID();
    createdProjectIds.push(projectId);
    await projects.createPendingUpload({
      projectId,
      idempotencyKey: `cleanup-${randomUUID()}`,
      requestFingerprint: "d".repeat(64),
      sourceId,
      artifactId,
      name: "Cleanup retry",
      rightsConfirmedAt: new Date(),
      rightsDeclarationVersion: "upload-rights-v1",
      originalFilename: "source.mp4",
      contentType: "video/mp4",
      sizeBytes: 100n,
      sha256: "d".repeat(64),
      sourceVersion: 1,
      objectKey: `sources/${projectId}/${sourceId}/v1/source.mp4`,
      recipeVersion: "source-ingest-v1",
    });
    await projects.markFailed(projectId, "TEST_CLEANUP", "Cleanup test.", true);
    const failingStorage: ObjectStorage = {
      ensurePrivateBucket: () => storage.ensurePrivateBucket(),
      putFile: (input) => storage.putFile(input),
      headObject: (key, signal) => storage.headObject(key, signal),
      deleteObject: async () =>
        Promise.reject(new Error("forced delete failure")),
    };

    await new ReconcilePendingUploads(projects, failingStorage).execute(
      new Date(),
      25,
      new AbortController().signal,
    );
    const failedAttempt = await prisma.mediaArtifact.findUniqueOrThrow({
      where: { id: artifactId },
    });
    expect(failedAttempt).toMatchObject({
      cleanupStatus: "PENDING",
      cleanupAttemptCount: 1,
      cleanupLastErrorCode: "OBJECT_DELETE_FAILED",
    });

    await reconciliation.execute(new Date(), 25, new AbortController().signal);
    const retried = await prisma.mediaArtifact.findUniqueOrThrow({
      where: { id: artifactId },
    });
    expect(retried.cleanupStatus).toBe("COMPLETED");
  });

  it("cleans a late upload when reconciliation already failed it with a different code", async () => {
    const idempotencyKey = `late-finalize-${randomUUID()}`;
    const filePath = join(uploadDirectory, `late-${randomUUID()}`);
    await writeFile(filePath, tinyMp4());
    let deleteAttempts = 0;
    let racingStorage: ObjectStorage;
    racingStorage = {
      ensurePrivateBucket: () => storage.ensurePrivateBucket(),
      headObject: (key, signal) => storage.headObject(key, signal),
      deleteObject: async (key, signal) => {
        deleteAttempts += 1;
        if (deleteAttempts === 1)
          throw new Error("forced first delete failure");
        await storage.deleteObject(key, signal);
      },
      putFile: async (input) => {
        const receipt = await storage.putFile({
          ...input,
          sha256: "f".repeat(64),
        });
        await new ReconcilePendingUploads(projects, racingStorage).execute(
          new Date(Date.now() + 1_000),
          25,
          new AbortController().signal,
        );
        return receipt;
      },
    };

    await expect(
      new CreateProjectWithSource(projects, racingStorage).execute({
        name: "Late finalize conflict",
        originalFilename: "source.mp4",
        filePath,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "DATABASE_FINALIZE_FAILED" });

    const project = await prisma.project.findUniqueOrThrow({
      where: { idempotencyKey },
      include: { artifacts: true },
    });
    createdProjectIds.push(project.id);
    expect(project).toMatchObject({
      status: "FAILED_FINAL",
      failureCode: "SOURCE_OBJECT_INTEGRITY_MISMATCH",
    });
    expect(project.artifacts[0]).toMatchObject({
      status: "FAILED_FINAL",
      cleanupStatus: "COMPLETED",
      cleanupAttemptCount: 1,
    });
    expect(deleteAttempts).toBe(2);
    await expect(
      storage.headObject(project.artifacts[0]!.objectKey),
    ).resolves.toBeNull();
  });
});
