import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaService } from "../src/database/prisma.service.js";

const ids = {
  newestHigh: "00000000-0000-4000-8000-000000000005",
  newestLow: "00000000-0000-4000-8000-000000000004",
  middle: "00000000-0000-4000-8000-000000000003",
  older: "00000000-0000-4000-8000-000000000002",
  oldest: "00000000-0000-4000-8000-000000000001",
  literalPercent: "00000000-0000-4000-8000-000000000006",
  literalUnderscore: "00000000-0000-4000-8000-000000000007",
  literalBackslash: "00000000-0000-4000-8000-000000000008",
} as const;

describe("projects media-library list API (PostgreSQL)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const projectIds = Object.values(ids);

  beforeAll(async () => {
    process.env.MEDIA_QUEUE_DISABLED = "1";
    const { createApp } = await import("../src/main.js");
    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });

    const newest = new Date("2026-09-02T05:00:00.000Z");
    await seedProject({
      prisma,
      id: ids.newestHigh,
      name: "Library fixture Alpha project",
      originalFilename: "camera-one.mp4",
      status: "SOURCE_READY",
      createdAt: newest,
      durationMs: 12_345,
      probeState: "READY",
      sourceCreatedAt: new Date("2026-09-02T05:01:00.000Z"),
      cutJobStates: [
        "QUEUED",
        "PROCESSING",
        "RETRY_WAIT",
        "READY",
        "FAILED_FINAL",
      ],
    });
    await seedProject({
      prisma,
      id: ids.newestLow,
      name: "Library fixture Second project",
      originalFilename: "ALPHA-source.mp4",
      status: "SOURCE_READY",
      createdAt: newest,
      durationMs: 67_890,
    });
    await seedProject({
      prisma,
      id: ids.middle,
      name: "Library fixture Alpha failed",
      originalFilename: "failed.mp4",
      status: "FAILED_FINAL",
      createdAt: new Date("2026-09-02T04:00:00.000Z"),
    });
    await seedProject({
      prisma,
      id: ids.older,
      name: "Library fixture Pending source",
      originalFilename: "pending.mp4",
      status: "SOURCE_PENDING",
      createdAt: new Date("2026-09-02T03:00:00.000Z"),
    });
    await seedProject({
      prisma,
      id: ids.oldest,
      name: "Library fixture Old source",
      originalFilename: "old.mp4",
      status: "SOURCE_READY",
      createdAt: new Date("2026-09-02T02:00:00.000Z"),
    });
    await seedProject({
      prisma,
      id: ids.literalPercent,
      name: "Percent % source",
      originalFilename: "percent.mp4",
      status: "SOURCE_READY",
      createdAt: new Date("2026-09-02T01:00:00.000Z"),
    });
    await seedProject({
      prisma,
      id: ids.literalUnderscore,
      name: "Underscore source",
      originalFilename: "under_score.mp4",
      status: "SOURCE_READY",
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    await seedProject({
      prisma,
      id: ids.literalBackslash,
      name: "Backslash source",
      originalFilename: "back\\slash.mp4",
      status: "SOURCE_READY",
      createdAt: new Date("2026-09-01T23:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await app.close();
  });

  it("paginates by createdAt and id without gaps or duplicates", async () => {
    const first = await request(app.getHttpServer())
      .get("/api/v1/projects?limit=2&q=library%20fixture")
      .expect(200);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual([
      ids.newestHigh,
      ids.newestLow,
    ]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app.getHttpServer())
      .get(
        `/api/v1/projects?limit=2&q=library%20fixture&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
      )
      .expect(200);
    const third = await request(app.getHttpServer())
      .get(
        `/api/v1/projects?limit=2&q=library%20fixture&cursor=${encodeURIComponent(second.body.nextCursor as string)}`,
      )
      .expect(200);

    const allIds = [first, second, third].flatMap((response) =>
      response.body.items.map((item: { id: string }) => item.id),
    );
    expect(allIds).toEqual([
      ids.newestHigh,
      ids.newestLow,
      ids.middle,
      ids.older,
      ids.oldest,
    ]);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(third.body.nextCursor).toBeNull();
  });

  it("filters case-insensitively by project or filename and combines status", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/projects?q=%20aLpHa%20&status=SOURCE_READY")
      .expect(200);

    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
      ids.newestHigh,
      ids.newestLow,
    ]);
    expect(response.body.items[0]).toMatchObject({
      name: "Library fixture Alpha project",
      status: "SOURCE_READY",
      source: {
        status: "READY",
        originalFilename: "camera-one.mp4",
        contentType: "video/mp4",
        sizeBytes: "1000",
        durationMs: 12_345,
        probeState: "READY",
        addedAt: "2026-09-02T05:01:00.000Z",
      },
      cutJobCounts: { total: 5, ready: 1, failed: 1 },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("objectKey");
    expect(serialized).not.toContain('"rights":');
    expect(serialized).not.toContain("sha256");
  });

  it.each([
    ["%", ids.literalPercent],
    ["_", ids.literalUnderscore],
    ["\\", ids.literalBackslash],
  ])("treats search token %s as a literal", async (token, expectedId) => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/projects?q=${encodeURIComponent(token)}`)
      .expect(200);

    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
      expectedId,
    ]);
  });

  it("publishes the bounded media-library query contract", async () => {
    const openApi = await request(app.getHttpServer())
      .get("/api/docs-json")
      .expect(200);
    const operation = openApi.body.paths["/api/v1/projects"].get;
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "cursor", in: "query" }),
        expect.objectContaining({
          name: "limit",
          in: "query",
          schema: expect.objectContaining({ minimum: 1, maximum: 50 }),
        }),
        expect.objectContaining({ name: "status", in: "query" }),
        expect.objectContaining({
          name: "q",
          in: "query",
          schema: expect.objectContaining({ maxLength: 200 }),
        }),
      ]),
    );
    expect(
      operation.responses["200"].content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/ProjectLibraryPageDto" });
  });

  it.each([
    "limit=0",
    "limit=51",
    "limit=1.5",
    "status=READY",
    `q=${"x".repeat(201)}`,
    "q=%00",
    "q=%0A",
    "cursor=not%2Bbase64url",
    `cursor=${Buffer.from("{}", "utf8").toString("base64url")}`,
  ])("returns a controlled 400 for invalid query: %s", async (query) => {
    await request(app.getHttpServer())
      .get(`/api/v1/projects?${query}`)
      .expect(400)
      .expect(({ body }) => {
        expect(body).toEqual({
          error: {
            code: expect.any(String),
            message: expect.any(String),
          },
        });
      });
  });
});

async function seedProject(input: {
  prisma: PrismaService;
  id: string;
  name: string;
  originalFilename: string;
  status: "SOURCE_PENDING" | "SOURCE_READY" | "FAILED_FINAL";
  createdAt: Date;
  sourceCreatedAt?: Date;
  durationMs?: number;
  probeState?:
    "QUEUED" | "PROCESSING" | "RETRY_WAIT" | "READY" | "FAILED_FINAL";
  cutJobStates?: Array<
    "QUEUED" | "PROCESSING" | "RETRY_WAIT" | "READY" | "FAILED_FINAL"
  >;
}): Promise<void> {
  const sourceId = randomUUID();
  const artifactId = randomUUID();
  const sourceStatus =
    input.status === "SOURCE_READY"
      ? "READY"
      : input.status === "SOURCE_PENDING"
        ? "PENDING"
        : "FAILED_FINAL";

  await input.prisma.$transaction(async (transaction) => {
    await transaction.project.create({
      data: {
        id: input.id,
        idempotencyKey: `library-${input.id}`,
        requestFingerprint: "f".repeat(64),
        name: input.name,
        status: input.status,
        rightsConfirmedAt: input.createdAt,
        rightsDeclarationVersion: "upload-rights-v1",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });
    await transaction.videoSource.create({
      data: {
        id: sourceId,
        projectId: input.id,
        status: sourceStatus,
        originalFilename: input.originalFilename,
        contentType: "video/mp4",
        sizeBytes: 1000n,
        sha256: "a".repeat(64),
        durationMs: input.durationMs,
        createdAt: input.sourceCreatedAt ?? input.createdAt,
        updatedAt: input.sourceCreatedAt ?? input.createdAt,
      },
    });
    await transaction.sourceAuthorization.create({
      data: {
        sourceId,
        sourceVersion: 1,
        status: "CLEARED",
        basis: "LEGACY_ATTESTATION",
        declarationVersion: "upload-rights-v1",
        decidedAt: input.createdAt,
      },
    });
    await transaction.mediaArtifact.create({
      data: {
        id: artifactId,
        projectId: input.id,
        sourceId,
        role: "SOURCE",
        status: sourceStatus,
        objectKey: `test/library/${input.id}/source.mp4`,
        sizeBytes: 1000n,
        sha256: "a".repeat(64),
        contentType: "video/mp4",
        lineageSourceId: sourceId,
        lineageSourceVersion: 1,
        recipeVersion: "source-ingest-v1",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });
    if (input.probeState) {
      await transaction.pipelineJob.create({
        data: {
          id: randomUUID(),
          projectId: input.id,
          sourceId,
          sourceVersion: 1,
          type: "SOURCE_PROBE",
          state: input.probeState,
          idempotencyKey: `library-probe-${input.id}`,
          recipeVersion: "source-probe-v1",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      });
    }
    for (const [index, state] of (input.cutJobStates ?? []).entries()) {
      await transaction.pipelineJob.create({
        data: {
          id: randomUUID(),
          projectId: input.id,
          sourceId,
          sourceVersion: 1,
          type: "CUT_SEGMENT",
          state,
          idempotencyKey: `library-cut-${input.id}-${index}`,
          recipeVersion: "cut-segment-v1",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      });
    }
  });
}
