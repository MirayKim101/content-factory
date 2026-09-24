import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApplyResearchMetadata } from "../src/ai-content/application/apply-research-metadata.js";
import { ResearchSuggestionContextRejectedError } from "../src/ai-content/application/research-suggestion-repository.port.js";
import { PrismaResearchSuggestionRepository } from "../src/ai-content/infrastructure/prisma-research-suggestion.repository.js";
import { PrismaTranscriptEvidenceRepository } from "../src/ai-content/infrastructure/prisma-transcript-evidence.repository.js";
import { databaseUrl } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { ApplyAiMetadata } from "../src/editorial-content/application/apply-ai-metadata.js";
import { SaveEditorialPackage } from "../src/editorial-content/application/save-editorial-package.js";
import { PrismaEditorialRepository } from "../src/editorial-content/infrastructure/prisma-editorial.repository.js";
import { seedFrameContext } from "./fixtures/frame-evidence-fixture.js";

describe("persisted cited research and exact metadata apply", () => {
  let prisma: PrismaService;
  let worker: { process(id: string): Promise<void>; close(): Promise<void> };

  beforeAll(async () => {
    if (process.env.POSTGRES_DB !== "cf_research_acceptance_20260924")
      throw new Error(
        "Explicit disposable POSTGRES_DB=cf_research_acceptance_20260924 required",
      );
    process.env.SOURCE_AUTHORIZATION_POLICY = "manual";
    prisma = new PrismaService();
    await prisma.$connect();
    const module = (await import(
      new URL(
        "../../worker/src/infrastructure/pg-research-worker.ts",
        import.meta.url,
      ).href
    )) as {
      PgResearchWorker: new (
        url: string,
        sourceAuthorizationPolicy: "manual" | "local-auto",
      ) => {
        process(id: string): Promise<void>;
        close(): Promise<void>;
      };
    };
    worker = new module.PgResearchWorker(databaseUrl(), "manual");
  });

  afterAll(async () => {
    await Promise.all([worker?.close(), prisma?.$disconnect()]);
  });

  it("survives reload, deduplicates worker delivery, preserves thumbnail and rejects stale apply", async () => {
    const fixture = await seedFrameContext(prisma);
    const transcriptRepository = new PrismaTranscriptEvidenceRepository(prisma);
    const transcriptId = await transcriptRepository.create({
      cutPipelineJobId: fixture.cutJobId,
      sourceContextRevisionId: fixture.contextRevisionId,
      cutPromptRevisionId: fixture.promptRevisionId,
      idempotencyKey: randomUUID(),
      language: "ru",
      fixture: {
        language: "ru",
        segments: [{ ordinal: 0, startMs: 0, endMs: 1_000, text: "Факт" }],
      },
    });
    const transcriptClaim = await transcriptRepository.claim(
      transcriptId,
      "research-integration",
    );
    expect(transcriptClaim).not.toBeNull();
    await transcriptRepository.complete({
      claim: transcriptClaim!,
      artifact: {
        id: randomUUID(),
        objectKey: `ai-content/transcripts/${transcriptId}/transcript.json`,
        contentType: "application/json",
        sizeBytes: 64,
        sha256: "c".repeat(64),
        adapterVersion: "local-manual-transcript-v1",
        language: "ru",
        segments: transcriptClaim!.fixture.segments,
      },
    });

    const researchRepository = new PrismaResearchSuggestionRepository(prisma);
    const researchRequest = {
      transcriptIntentId: transcriptId,
      idempotencyKey: randomUUID(),
      query: "Проверить ключевой факт",
      citations: [
        {
          url: "https://example.com/fact",
          title: "Primary fact",
          publisher: "Example",
          publishedAt: "2026-09-23T00:00:00.000Z",
          excerpt: "Проверенный оператором факт.",
        },
      ],
    };
    const researchId = await researchRepository.create(researchRequest);
    await expect(researchRepository.create(researchRequest)).resolves.toBe(
      researchId,
    );
    await worker.process(researchId);
    await worker.process(researchId);

    const reloaded = new PrismaResearchSuggestionRepository(prisma);
    const durable = await reloaded.detail(researchId);
    expect(durable).toMatchObject({
      state: "READY",
      cost: { directCostMicrousd: "0" },
    });
    expect(
      await prisma.researchSuggestionAttempt.count({
        where: { intentId: researchId },
      }),
    ).toBe(1);

    const editorialRepository = new PrismaEditorialRepository(prisma);
    const template = await editorialRepository.createTemplate({
      templateId: randomUUID(),
      revisionId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestFingerprint: "template-v1",
      name: "Research integration",
    });
    const thumbnailId = randomUUID();
    await prisma.editorialAsset.create({
      data: {
        id: thumbnailId,
        projectId: fixture.projectId,
        type: "THUMBNAIL",
        status: "READY",
        idempotencyKey: randomUUID(),
        requestFingerprint: "thumbnail-v1",
        objectKey: `test/thumbnail/${thumbnailId}`,
        originalFilename: "cover.png",
        contentType: "image/png",
        sizeBytes: 128n,
        sha256: "d".repeat(64),
        width: 1280,
        height: 720,
      },
    });
    const save = new SaveEditorialPackage(editorialRepository);
    const initial = await save.execute({
      pipelineJobId: fixture.cutJobId,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      processingTemplateRevisionId: template.id,
      title: "Manual title",
      description: "Manual description",
      tags: ["manual"],
      thumbnailAssetId: thumbnailId,
    });
    const apply = new ApplyResearchMetadata(
      reloaded,
      new ApplyAiMetadata(editorialRepository, save),
    );
    const suggestion = durable!.suggestion!;
    const applyKey = randomUUID();
    const applied = await apply.execute({
      researchIntentId: researchId,
      expectedEditorialRevision: initial.revision.revision,
      idempotencyKey: applyKey,
      title: suggestion.title,
      description: suggestion.description,
      tags: [...suggestion.tags],
    });
    expect(applied.revision).toMatchObject({
      revision: 2,
      thumbnail: { id: thumbnailId },
      provenance: { metadata: { mode: "AI_ASSISTED" } },
    });
    await expect(
      apply.execute({
        researchIntentId: researchId,
        expectedEditorialRevision: initial.revision.revision,
        idempotencyKey: applyKey,
        title: suggestion.title,
        description: suggestion.description,
        tags: [...suggestion.tags],
      }),
    ).resolves.toMatchObject({ revision: { revision: 2 } });
    expect(
      await prisma.editorialPackageRevision.count({
        where: { packageId: applied.id },
      }),
    ).toBe(2);

    await prisma.sourceAuthorization.update({
      where: {
        sourceId_sourceVersion: {
          sourceId: fixture.sourceId,
          sourceVersion: 1,
        },
      },
      data: {
        status: "NOT_REVIEWED",
        basis: null,
        declarationVersion: null,
        decidedAt: null,
        revision: { increment: 1 },
      },
    });
    await expect(researchRepository.create(researchRequest)).resolves.toBe(
      researchId,
    );
    await expect(
      apply.execute({
        researchIntentId: researchId,
        expectedEditorialRevision: 2,
        idempotencyKey: randomUUID(),
        title: "Unsafe edit",
        description: suggestion.description,
        tags: [...suggestion.tags],
      }),
    ).rejects.toBeInstanceOf(ResearchSuggestionContextRejectedError);
    expect(
      (
        await prisma.editorialPackage.findUnique({
          where: { pipelineJobId: fixture.cutJobId },
          select: { currentRevision: true },
        })
      )?.currentRevision,
    ).toBe(2);
  });
});
