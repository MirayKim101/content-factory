import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ApplyImageSuggestion } from "../src/ai-content/application/apply-image-suggestion.js";
import { ImageSuggestionContextRejectedError } from "../src/ai-content/application/image-suggestion-repository.port.js";
import { PrismaImageSuggestionRepository } from "../src/ai-content/infrastructure/prisma-image-suggestion.repository.js";
import { databaseUrl } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { ApplyAiThumbnail } from "../src/editorial-content/application/apply-ai-thumbnail.js";
import { EditorialIdempotencyConflictError, EditorialRevisionConflictError } from "../src/editorial-content/application/editorial-repository.port.js";
import { SaveEditorialPackage } from "../src/editorial-content/application/save-editorial-package.js";
import { PrismaEditorialRepository } from "../src/editorial-content/infrastructure/prisma-editorial.repository.js";
import { seedFrameContext } from "./fixtures/frame-evidence-fixture.js";

describe("durable no-likeness thumbnail suggestion and exact apply", () => {
  let prisma: PrismaService;
  let worker: { process(id: string): Promise<void>; close(): Promise<void> };
  const uploaded = new Map<string, Buffer>();
  const cleanupKeys = new Set<string>();
  let objectStorage: {
    uploadBytes(input: { objectKey: string; bytes: Buffer; contentType: string; sha256: string }): Promise<{ etag?: string }>;
    delete(key: string): Promise<void>;
    read?(key: string, signal: AbortSignal): Promise<NodeJS.ReadableStream>;
    close?(): void;
  };

  beforeAll(async () => {
    if (process.env.POSTGRES_DB !== "cf_research_acceptance_20260924") throw new Error("Explicit disposable database required");
    process.env.SOURCE_AUTHORIZATION_POLICY = "manual";
    prisma = new PrismaService(); await prisma.$connect();
    const module = (await import(new URL("../../worker/src/infrastructure/pg-image-suggestion-worker.ts", import.meta.url).href)) as {
      PgImageSuggestionWorker: new (url: string, policy: "manual", storage: {
        uploadBytes(input: { objectKey: string; bytes: Buffer; contentType: string; sha256: string }): Promise<{ etag?: string }>;
        delete(key: string): Promise<void>;
      }) => { process(id: string): Promise<void>; close(): Promise<void> };
    };
    if (process.env.IMAGE_STORAGE_SMOKE === "1") {
      const [storageModule, configModule] = (await Promise.all([
        import(new URL("../../worker/src/infrastructure/s3-worker-object-storage.ts", import.meta.url).href),
        import(new URL("../../worker/src/config.ts", import.meta.url).href),
      ])) as [
        { S3WorkerObjectStorage: new (bucket: string, config: { endpoint: string; region: string; accessKey: string; secretKey: string }) => typeof objectStorage },
        { workerConfig(): { storage: { bucket: string; endpoint: string; region: string; accessKey: string; secretKey: string } } },
      ];
      const config = configModule.workerConfig();
      objectStorage = new storageModule.S3WorkerObjectStorage(config.storage.bucket, config.storage);
    } else {
      objectStorage = {
        uploadBytes: vi.fn(async (input) => { uploaded.set(input.objectKey, Buffer.from(input.bytes)); return { etag: "integration-etag" }; }),
        delete: vi.fn(async (key) => { uploaded.delete(key); }),
      };
    }
    worker = new module.PgImageSuggestionWorker(databaseUrl(), "manual", objectStorage);
  });

  afterAll(async () => {
    await Promise.all([...cleanupKeys].map((key) => objectStorage?.delete(key).catch(() => undefined)));
    objectStorage?.close?.();
    await Promise.all([worker?.close(), prisma?.$disconnect()]);
  });

  it("survives reload, deduplicates delivery and atomically applies one private thumbnail", async () => {
    const fixture = await seedFrameContext(prisma);
    const repository = new PrismaImageSuggestionRepository(prisma);
    const beforeForeignProjectAttempt = await prisma.imageSuggestionIntent.count();
    await expect(repository.create({
      projectId: randomUUID(),
      cutPipelineJobId: fixture.cutJobId,
      sourceContextRevisionId: fixture.contextRevisionId,
      cutPromptRevisionId: fixture.promptRevisionId,
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: "IMAGE_CONTEXT_REQUIRED" });
    expect(await prisma.imageSuggestionIntent.count()).toBe(beforeForeignProjectAttempt);
    const request = { projectId: fixture.projectId, cutPipelineJobId: fixture.cutJobId, sourceContextRevisionId: fixture.contextRevisionId, cutPromptRevisionId: fixture.promptRevisionId, idempotencyKey: randomUUID() };
    const intentId = await repository.create(request);
    await expect(repository.create(request)).resolves.toBe(intentId);
    await worker.process(intentId); await worker.process(intentId);
    const durable = await new PrismaImageSuggestionRepository(prisma).detail(intentId);
    expect(durable).toMatchObject({ state: "READY", candidate: { likeness: "NONE", contentType: "image/png", directCostMicrousd: "0", width: 1280, height: 720 } });
    const storedCandidate = await prisma.imageSuggestionCandidate.findUniqueOrThrow({ where: { intentId } });
    const objectKey = storedCandidate.objectKey;
    cleanupKeys.add(objectKey);
    let storedBytes = uploaded.get(objectKey);
    if (!storedBytes && objectStorage.read) {
      const stream = await objectStorage.read(objectKey, new AbortController().signal);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) chunks.push(Buffer.from(chunk));
      storedBytes = Buffer.concat(chunks);
    }
    expect(storedBytes?.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(await prisma.imageSuggestionAttempt.count({ where: { intentId } })).toBe(1);

    const editorialRepository = new PrismaEditorialRepository(prisma);
    const template = await editorialRepository.createTemplate({ templateId: randomUUID(), revisionId: randomUUID(), idempotencyKey: randomUUID(), requestFingerprint: "image-template-v1", name: "Image integration" });
    const manualThumbnailId = randomUUID();
    await prisma.editorialAsset.create({ data: { id: manualThumbnailId, projectId: fixture.projectId, type: "THUMBNAIL", status: "READY", idempotencyKey: randomUUID(), requestFingerprint: "manual-image-v1", objectKey: `test/manual-thumbnail/${manualThumbnailId}`, originalFilename: "manual.png", contentType: "image/png", sizeBytes: 128n, sha256: "d".repeat(64), width: 1280, height: 720 } });
    const save = new SaveEditorialPackage(editorialRepository);
    const initial = await save.execute({ pipelineJobId: fixture.cutJobId, expectedRevision: 0, idempotencyKey: randomUUID(), processingTemplateRevisionId: template.id, title: "Manual title", description: "Manual description", tags: ["manual"], thumbnailAssetId: manualThumbnailId });
    const thumbnailApplier = new ApplyAiThumbnail(editorialRepository, save);
    const apply = new ApplyImageSuggestion(repository, thumbnailApplier);
    const resolvedBeforeMutation = await repository.resolveForApply(intentId);
    await prisma.cutSegment.update({ where: { jobId: fixture.cutJobId }, data: { startMs: { increment: 1 } } });
    await expect(thumbnailApplier.apply({
      pipelineJobId: fixture.cutJobId,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      provenance: {
        mode: "AI_ASSISTED",
        basisVersion: `${resolvedBeforeMutation.candidate.costBasisVersion}:${resolvedBeforeMutation.candidate.sha256}`,
        imageIntentId: intentId,
        imageCandidateId: resolvedBeforeMutation.candidate.id,
      },
    })).rejects.toBeInstanceOf(EditorialRevisionConflictError);
    await prisma.cutSegment.update({ where: { jobId: fixture.cutJobId }, data: { startMs: { decrement: 1 } } });
    const applyKey = randomUUID();
    const applied = await apply.execute({ imageIntentId: intentId, expectedEditorialRevision: 1, idempotencyKey: applyKey });
    expect(applied.revision).toMatchObject({ revision: 2, title: initial.revision.title, description: initial.revision.description, tags: initial.revision.tags, provenance: { metadata: { mode: "MANUAL" }, thumbnail: { mode: "AI_ASSISTED", imageIntentId: intentId, imageCandidateId: intentId } } });
    expect(applied.revision.thumbnail?.id).not.toBe(manualThumbnailId);
    await expect(apply.execute({ imageIntentId: intentId, expectedEditorialRevision: 1, idempotencyKey: applyKey })).resolves.toMatchObject({ revision: { revision: 2 } });
    expect(await prisma.editorialPackageRevision.count({ where: { packageId: applied.id } })).toBe(2);
    expect(await prisma.editorialAsset.count({ where: { projectId: fixture.projectId } })).toBe(2);
    const manualEdit = await save.execute({
      pipelineJobId: fixture.cutJobId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      processingTemplateRevisionId: template.id,
      title: "Manually adjusted title",
      description: initial.revision.description,
      tags: initial.revision.tags,
      thumbnailAssetId: applied.revision.thumbnail!.id,
    });
    expect(manualEdit.revision).toMatchObject({
      revision: 3,
      provenance: { thumbnail: { mode: "AI_ASSISTED", imageIntentId: intentId, imageCandidateId: intentId } },
    });
    const secondManualThumbnailId = randomUUID();
    await prisma.editorialAsset.create({ data: { id: secondManualThumbnailId, projectId: fixture.projectId, type: "THUMBNAIL", status: "READY", idempotencyKey: randomUUID(), requestFingerprint: "manual-image-v2", objectKey: `test/manual-thumbnail/${secondManualThumbnailId}`, originalFilename: "manual-2.png", contentType: "image/png", sizeBytes: 256n, sha256: "e".repeat(64), width: 1280, height: 720 } });
    const replaced = await save.execute({ pipelineJobId: fixture.cutJobId, expectedRevision: 3, idempotencyKey: randomUUID(), processingTemplateRevisionId: template.id, title: manualEdit.revision.title, description: manualEdit.revision.description, tags: manualEdit.revision.tags, thumbnailAssetId: secondManualThumbnailId });
    expect(replaced.revision.provenance.thumbnail.mode).toBe("MANUAL");
    const reapplied = await apply.execute({ imageIntentId: intentId, expectedEditorialRevision: 4, idempotencyKey: randomUUID() });
    expect(reapplied.revision).toMatchObject({ revision: 5, thumbnail: { id: applied.revision.thumbnail!.id }, provenance: { thumbnail: { imageIntentId: intentId } } });
    expect(await prisma.editorialAsset.count({ where: { objectKey } })).toBe(1);
    const collisionKey = randomUUID();
    await save.execute({ pipelineJobId: fixture.cutJobId, expectedRevision: 5, idempotencyKey: collisionKey, processingTemplateRevisionId: template.id, title: "Different operation", description: reapplied.revision.description, tags: reapplied.revision.tags, thumbnailAssetId: reapplied.revision.thumbnail!.id });
    await expect(apply.execute({ imageIntentId: intentId, expectedEditorialRevision: 5, idempotencyKey: collisionKey })).rejects.toBeInstanceOf(EditorialIdempotencyConflictError);

    await prisma.sourceAuthorization.update({ where: { sourceId_sourceVersion: { sourceId: fixture.sourceId, sourceVersion: 1 } }, data: { status: "NOT_REVIEWED", basis: null, declarationVersion: null, decidedAt: null, revision: { increment: 1 } } });
    await expect(apply.execute({ imageIntentId: intentId, expectedEditorialRevision: 1, idempotencyKey: applyKey })).resolves.toMatchObject({ revision: { revision: 2 } });
    await expect(repository.resolveContent(intentId, intentId)).rejects.toBeInstanceOf(ImageSuggestionContextRejectedError);
    await expect(apply.execute({ imageIntentId: intentId, expectedEditorialRevision: 6, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ImageSuggestionContextRejectedError);
    expect((await prisma.editorialPackage.findUnique({ where: { pipelineJobId: fixture.cutJobId }, select: { currentRevision: true } }))?.currentRevision).toBe(6);
  });
});
