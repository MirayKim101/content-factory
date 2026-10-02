import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ClipGenerationService } from "../src/ai-content/clip-generation/clip-generation.service.js";
import { PrismaService } from "../src/database/prisma.service.js";

describe("clip generation intent persistence (PostgreSQL)", () => {
  let prisma: PrismaService;
  let previousModel: string | undefined;
  const projectIds: string[] = [];

  beforeAll(async () => {
    previousModel = process.env.CLIP_GENERATION_MODEL;
    process.env.CLIP_GENERATION_MODEL = "test-model";
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterEach(async () => {
    for (const projectId of projectIds.splice(0)) {
      await prisma.clipGenerationAcceptance.deleteMany({
        where: { intent: { projectId } },
      });
      await prisma.clipGenerationSuggestion.deleteMany({
        where: { intent: { projectId } },
      });
      await prisma.clipGenerationIntent.deleteMany({ where: { projectId } });
      await prisma.project.deleteMany({ where: { id: projectId } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (previousModel === undefined) delete process.env.CLIP_GENERATION_MODEL;
    else process.env.CLIP_GENERATION_MODEL = previousModel;
  });

  it("deduplicates an exact request and rejects changed payload or missing consent before insert", async () => {
    const projectId = await createSource("OPERATOR_ATTESTATION");
    const service = new ClipGenerationService(prisma);
    const idempotencyKey = `clip-api-${randomUUID()}`;
    const body = request(true);

    const created = await service.create(projectId, idempotencyKey, body);
    await expect(
      service.create(projectId, idempotencyKey, body),
    ).resolves.toMatchObject({ id: created.id, state: "QUEUED" });
    await expect(
      service.create(projectId, idempotencyKey, {
        ...body,
        sourceTitle: "Changed title",
      }),
    ).rejects.toMatchObject({
      response: { code: "CLIP_GENERATION_IDEMPOTENCY_CONFLICT" },
    });

    const beforeDenied = await prisma.clipGenerationIntent.count({
      where: { projectId },
    });
    await expect(
      service.create(projectId, `clip-denied-${randomUUID()}`, request(false)),
    ).rejects.toMatchObject({
      response: { code: "CLIP_GENERATION_EXTERNAL_TRANSFER_REQUIRED" },
    });
    expect(
      await prisma.clipGenerationIntent.count({ where: { projectId } }),
    ).toBe(beforeDenied);
  });

  it("rejects local-development authorization before persisting external transfer", async () => {
    const projectId = await createSource("LOCAL_DEVELOPMENT_AUTO");
    const service = new ClipGenerationService(prisma);
    await expect(
      service.create(projectId, `clip-rights-${randomUUID()}`, request(true)),
    ).rejects.toMatchObject({
      response: { code: "CLIP_GENERATION_RIGHTS_NOT_CLEARED" },
    });
    expect(
      await prisma.clipGenerationIntent.count({ where: { projectId } }),
    ).toBe(0);
  });

  async function createSource(
    basis: "OPERATOR_ATTESTATION" | "LOCAL_DEVELOPMENT_AUTO",
  ): Promise<string> {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    projectIds.push(projectId);
    await prisma.project.create({
      data: {
        id: projectId,
        idempotencyKey: `clip-api-source-${randomUUID()}`,
        requestFingerprint: "1".repeat(64),
        name: "Clip API persistence",
        status: "SOURCE_READY",
        rightsConfirmedAt: new Date(),
        rightsDeclarationVersion: "upload-rights-v1",
        source: {
          create: {
            id: sourceId,
            status: "READY",
            originalFilename: "source.mp4",
            contentType: "video/mp4",
            sizeBytes: 24n,
            sha256: "2".repeat(64),
            durationMs: 120_000,
            probedAt: new Date(),
            probeVersion: "ffprobe integration",
            authorizations: {
              create: {
                sourceVersion: 1,
                status: "CLEARED",
                basis,
                declarationVersion:
                  basis === "LOCAL_DEVELOPMENT_AUTO"
                    ? "local-development-auto-v1"
                    : "upload-rights-v1",
                decidedAt: new Date(),
              },
            },
          },
        },
      },
    });
    return projectId;
  }
});

function request(externalProviderTransferAllowed: boolean) {
  return {
    sourceTitle: "Test stream",
    transcript: [{ startMs: 0, endMs: 120_000, text: "Complete moment" }],
    maximumSuggestions: 2,
    minimumClipDurationMs: 10_000,
    maximumClipDurationMs: 60_000,
    language: "en",
    externalProviderTransferAllowed,
  };
}
