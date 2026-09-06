import "reflect-metadata";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CreatorContextStorage } from "../src/ai-content/application/creator-context-storage.port.js";
import { CreatorContextService } from "../src/ai-content/application/creator-context.service.js";
import {
  RESOLVE_AI_EDITORIAL_CONTEXT,
  type ResolveAiEditorialContextPort,
} from "../src/ai-content/application/resolve-ai-editorial-context.port.js";
import { PrismaCreatorContextRepository } from "../src/ai-content/infrastructure/prisma-creator-context.repository.js";
import { StructuralReferenceImageInspector } from "../src/ai-content/infrastructure/reference-image-inspector.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { png } from "./fixtures/thumbnail-fixture.js";

describe("Stage 2B creator context API (PostgreSQL)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const marker = `creator-context-${randomUUID()}`;
  const projectIds: string[] = [];
  const profileIds: string[] = [];
  const previousEnvironment = {
    AI_CONTEXT_ENABLED: process.env.AI_CONTEXT_ENABLED,
    MEDIA_QUEUE_DISABLED: process.env.MEDIA_QUEUE_DISABLED,
    SOURCE_PENDING_STALE_AFTER_MS: process.env.SOURCE_PENDING_STALE_AFTER_MS,
  };
  const key = (suffix: string): string => `${marker}-${suffix}`;

  beforeAll(async () => {
    process.env.MEDIA_QUEUE_DISABLED = "1";
    process.env.AI_CONTEXT_ENABLED = "1";
    // This scenario verifies HTTP/PostgreSQL behavior and creates its reference
    // fixture directly. Keep unrelated stale upload fixtures from making app
    // bootstrap depend on a live object store.
    process.env.SOURCE_PENDING_STALE_AFTER_MS = "315360000000";
    const { createApp } = await import("../src/main.js");
    app = await createApp();
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.aiContentOperationRequest.deleteMany({
        where: {
          OR: [
            { creatorProfileId: { in: profileIds } },
            { resolvedProjectId: { in: projectIds } },
          ],
        },
      });
      await prisma.cutEditorialPromptRevision.deleteMany({
        where: { prompt: { projectId: { in: projectIds } } },
      });
      await prisma.cutEditorialPrompt.deleteMany({
        where: { projectId: { in: projectIds } },
      });
      await prisma.sourceEditorialContextRevision.deleteMany({
        where: { projectId: { in: projectIds } },
      });
      await prisma.sourceEditorialContext.deleteMany({
        where: { projectId: { in: projectIds } },
      });
      await prisma.creatorProfileRevision.deleteMany({
        where: { creatorProfileId: { in: profileIds } },
      });
      await prisma.creatorReferenceAuthorizationRevision.deleteMany({
        where: { referenceAsset: { creatorProfileId: { in: profileIds } } },
      });
      await prisma.creatorReferenceAsset.deleteMany({
        where: { creatorProfileId: { in: profileIds } },
      });
      await prisma.creatorProfileOfficialUrlIdentity.deleteMany({
        where: { creatorProfileId: { in: profileIds } },
      });
      await prisma.creatorProfile.deleteMany({
        where: { id: { in: profileIds } },
      });
      await prisma.mediaArtifact.deleteMany({
        where: { projectId: { in: projectIds } },
      });
      await prisma.pipelineJob.deleteMany({
        where: { projectId: { in: projectIds } },
      });
      await prisma.sourceAuthorization.deleteMany({
        where: { source: { projectId: { in: projectIds } } },
      });
      await prisma.videoSource.deleteMany({
        where: { projectId: { in: projectIds } },
      });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    }
    await app?.close();
    restoreEnvironment(
      "AI_CONTEXT_ENABLED",
      previousEnvironment.AI_CONTEXT_ENABLED,
    );
    restoreEnvironment(
      "MEDIA_QUEUE_DISABLED",
      previousEnvironment.MEDIA_QUEUE_DISABLED,
    );
    restoreEnvironment(
      "SOURCE_PENDING_STALE_AFTER_MS",
      previousEnvironment.SOURCE_PENDING_STALE_AFTER_MS,
    );
  });

  it("round-trips private revisions and keeps exact rights/source/cut lineage", async () => {
    const jobsBefore = await prisma.pipelineJob.count();
    const attemptsBefore = await prisma.jobAttempt.count();
    const editableRevision = {
      canonicalDisplayName: "Стример Один",
      officialUrl: "https://EXAMPLE.com:443/creator/%7eone/",
      primaryLanguage: "ru",
      topics: ["Dota 2", "стримы"],
      editorialNotes: "Приватная заметка",
      restrictions: ["Не использовать оскорбления"],
    };
    const created = await request(app.getHttpServer())
      .post("/api/v1/creator-profiles")
      .set("Idempotency-Key", key("profile-create"))
      .send(editableRevision)
      .expect(201);
    profileIds.push(created.body.id);
    expect(created.body.revision).toMatchObject({
      revision: 1,
      editableRevision: {
        ...editableRevision,
        officialUrl: "https://example.com/creator/~one",
      },
      likenessPolicy: "NO_REALISTIC_LIKENESS",
      defaultReference: null,
    });

    const replay = await request(app.getHttpServer())
      .post("/api/v1/creator-profiles")
      .set("Idempotency-Key", key("profile-create"))
      .send(editableRevision)
      .expect(201);
    expect(replay.body).toEqual(created.body);
    await request(app.getHttpServer())
      .post("/api/v1/creator-profiles")
      .set("Idempotency-Key", key("profile-create"))
      .send({ ...editableRevision, canonicalDisplayName: "Другой" })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT"),
      );

    const summaries = await request(app.getHttpServer())
      .get("/api/v1/creator-profiles?limit=100")
      .expect(200);
    const summary = summaries.body.items.find(
      (item: { id: string }) => item.id === created.body.id,
    );
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty("editorialNotes");
    expect(summary).not.toHaveProperty("restrictions");
    expect(JSON.stringify(summary)).not.toContain("Приватная заметка");

    await request(app.getHttpServer())
      .post("/api/v1/creator-profiles")
      .set("Idempotency-Key", key("semantic-conflict"))
      .send({
        ...editableRevision,
        officialUrl: "https://example.com/creator/~one/",
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body.error.code).toBe("CREATOR_PROFILE_OFFICIAL_URL_CONFLICT");
        expect(body.error.existingProfileId).toBe(created.body.id);
      });

    const updated = await request(app.getHttpServer())
      .put(`/api/v1/creator-profiles/${created.body.id}`)
      .set("Idempotency-Key", key("profile-update"))
      .send({
        ...created.body.revision.editableRevision,
        expectedRevision: 1,
        officialUrl: "https://example.com/creator/new",
      })
      .expect(200);
    expect(updated.body.currentRevision).toBe(2);
    expect(updated.body.revision.editableRevision.editorialNotes).toBe(
      "Приватная заметка",
    );
    await request(app.getHttpServer())
      .post("/api/v1/creator-profiles")
      .set("Idempotency-Key", key("old-alias-conflict"))
      .send(editableRevision)
      .expect(409);

    const assetId = randomUUID();
    const initialAuthorizationId = randomUUID();
    await prisma.creatorReferenceAsset.create({
      data: {
        id: assetId,
        creatorProfileId: created.body.id,
        status: "READY",
        objectKey: `test/${marker}/${assetId}`,
        originalFilename: "лицо.png",
        contentType: "image/png",
        sizeBytes: 100n,
        sha256: "d".repeat(64),
        width: 1280,
        height: 720,
        authorizations: {
          create: {
            id: initialAuthorizationId,
            revision: 1,
            status: "NOT_REVIEWED",
          },
        },
      },
    });
    const cleared = await request(app.getHttpServer())
      .put(
        `/api/v1/creator-profiles/${created.body.id}/reference-assets/${assetId}/authorization`,
      )
      .set("Idempotency-Key", key("rights-clear"))
      .send({
        expectedRevision: 1,
        decision: "CLEARED",
        declarationVersion: "creator-likeness-rights-v1",
        commercialAiImageUseAttested: true,
        basis: "Договор с автором",
        scope: "Коммерческие превью YouTube",
        expiresAt: null,
        externalProviderTransferAllowed: false,
      })
      .expect(200);
    expect(cleared.body.current.revision).toBe(2);

    const beforeDefault = await request(app.getHttpServer())
      .get(`/api/v1/creator-profiles/${created.body.id}`)
      .expect(200);
    expect(beforeDefault.body.revision.defaultReference).toBeNull();
    const selected = await request(app.getHttpServer())
      .put(`/api/v1/creator-profiles/${created.body.id}/default-reference`)
      .set("Idempotency-Key", key("default-set"))
      .send({
        expectedProfileRevision: 2,
        action: "SET",
        assetId,
        authorizationRevisionId: cleared.body.current.id,
        authorizationRevision: 2,
      })
      .expect(200);
    expect(selected.body.revision.likenessUsability.usable).toBe(true);

    const cut = await readyCut();
    const contextBody = {
      expectedRevision: 0,
      creatorProfileId: created.body.id,
      creatorProfileRevision: 3,
      sourceTitle: "Исходный стрим",
      gameOrTopic: "Dota 2",
      audience: "Зрители стримера",
      editorialGoal: "Подготовить понятный ролик",
      language: "ru",
      defaultCta: "Подписывайтесь",
      restrictions: ["Без выдуманных фактов"],
      operatorNotes: "Приватный контекст исходника",
    };
    const context = await request(app.getHttpServer())
      .put(
        `/api/v1/projects/${cut.projectId}/sources/${cut.sourceId}/versions/1/editorial-context`,
      )
      .set("Idempotency-Key", key("context"))
      .send(contextBody)
      .expect(200);
    expect(context.body.revision.status).toBe("CURRENT");
    expect(context.body.revision.editableRevision.operatorNotes).toBe(
      "Приватный контекст исходника",
    );

    const prompt = await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${cut.jobId}/editorial-prompt`)
      .set("Idempotency-Key", key("prompt"))
      .send({
        expectedRevision: 0,
        sourceContextId: context.body.id,
        sourceContextRevision: 1,
        whatHappens: "Команда переворачивает игру",
        desiredAngle: "Камбэк",
        tone: "Энергичный",
        cta: "Подписывайтесь",
        restrictions: ["Не раскрывать результат в заголовке"],
      })
      .expect(200);
    expect(prompt.body.revision).toMatchObject({
      status: "CURRENT",
      projectId: cut.projectId,
      sourceId: cut.sourceId,
      sourceVersion: 1,
    });
    expect(prompt.body.revision.contextPolicyFingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const promptRequestBody = {
      expectedRevision: 0,
      sourceContextId: context.body.id,
      sourceContextRevision: 1,
      whatHappens: "Команда переворачивает игру",
      desiredAngle: "Камбэк",
      tone: "Энергичный",
      cta: "Подписывайтесь",
      restrictions: ["Не раскрывать результат в заголовке"],
    };
    const resultArtifact = await prisma.mediaArtifact.findUniqueOrThrow({
      where: { pipelineJobId: cut.jobId },
    });
    await prisma.mediaArtifact.update({
      where: { id: resultArtifact.id },
      data: { sha256: "c".repeat(64) },
    });
    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${cut.jobId}/editorial-prompt`)
      .set("Idempotency-Key", key("prompt"))
      .send(promptRequestBody)
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT"),
      );
    await prisma.mediaArtifact.update({
      where: { id: resultArtifact.id },
      data: { sha256: resultArtifact.sha256 },
    });

    const resolver = app.get<ResolveAiEditorialContextPort>(
      RESOLVE_AI_EDITORIAL_CONTEXT,
    );
    const initiallyUsable = await resolver.resolve({
      cutPipelineJobId: cut.jobId,
      capability: "REALISTIC_LIKENESS_IMAGE",
    });
    expect(initiallyUsable).toMatchObject({ admitted: true, blockers: [] });
    expect(initiallyUsable.chain).toMatchObject({
      projectId: cut.projectId,
      cut: {
        pipelineJobId: cut.jobId,
        resultArtifactId: resultArtifact.id,
        resultSha256: resultArtifact.sha256,
      },
      sourceContext: { revisionId: context.body.revision.id, revision: 1 },
      creatorProfile: { revision: 3, currentRevision: 3 },
    });

    const otherCut = await readyCut();
    await request(app.getHttpServer())
      .put(`/api/v1/pipeline-jobs/${otherCut.jobId}/editorial-prompt`)
      .set("Idempotency-Key", key("cross-project-prompt"))
      .send({
        expectedRevision: 0,
        sourceContextId: context.body.id,
        sourceContextRevision: 1,
        whatHappens: "Другой проект",
        desiredAngle: "Нельзя связать",
        tone: "Нейтральный",
        cta: "",
        restrictions: [],
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body.error.code).toBe("CUT_EDITORIAL_PROMPT_LINEAGE_INVALID"),
      );
    await request(app.getHttpServer())
      .get("/api/v1/creator-profiles/not-a-uuid")
      .expect(400);

    const jobsAfterContext = await prisma.pipelineJob.count();
    expect(jobsAfterContext).toBe(jobsBefore + 2);
    const revoked = await request(app.getHttpServer())
      .put(
        `/api/v1/creator-profiles/${created.body.id}/reference-assets/${assetId}/authorization`,
      )
      .set("Idempotency-Key", key("rights-revoke"))
      .send({ expectedRevision: 2, decision: "REVOKED" })
      .expect(200);
    expect(revoked.body.current.status).toBe("REVOKED");
    const afterRevoke = await request(app.getHttpServer())
      .get(`/api/v1/creator-profiles/${created.body.id}`)
      .expect(200);
    expect(afterRevoke.body.revision.likenessUsability).toMatchObject({
      usable: false,
      blocker: "DEFAULT_REFERENCE_AUTHORIZATION_REVOKED",
    });
    const fakeProvider = vi.fn(async () => "should-not-run");
    const likenessAfterRevoke = await resolver.resolve({
      cutPipelineJobId: cut.jobId,
      capability: "REALISTIC_LIKENESS_IMAGE",
    });
    if (likenessAfterRevoke.admitted) await fakeProvider();
    expect(fakeProvider).not.toHaveBeenCalled();
    expect(likenessAfterRevoke.blockers).toEqual([
      "DEFAULT_REFERENCE_AUTHORIZATION_REVOKED",
    ]);
    expect(likenessAfterRevoke.contextPolicyFingerprint).not.toBe(
      initiallyUsable.contextPolicyFingerprint,
    );
    expect(
      await resolver.resolve({
        cutPipelineJobId: cut.jobId,
        capability: "REALISTIC_LIKENESS_IMAGE",
      }),
    ).toEqual(likenessAfterRevoke);
    expect(
      await resolver.resolve({
        cutPipelineJobId: cut.jobId,
        capability: "TEXT_GENERATION",
      }),
    ).toMatchObject({ admitted: true, blockers: [] });

    await request(app.getHttpServer())
      .put(`/api/v1/creator-profiles/${created.body.id}`)
      .set("Idempotency-Key", key("profile-stale"))
      .send({
        ...selected.body.revision.editableRevision,
        expectedRevision: 3,
        editorialNotes: "Новая приватная заметка",
      })
      .expect(200);
    const stalePrompt = await request(app.getHttpServer())
      .get(`/api/v1/pipeline-jobs/${cut.jobId}/editorial-prompt`)
      .expect(200);
    expect(stalePrompt.body.revision.status).toBe("STALE");
    expect(stalePrompt.body.revision.blockers).toContain(
      "CREATOR_PROFILE_REVISION_STALE",
    );
    const staleText = await resolver.resolve({
      cutPipelineJobId: cut.jobId,
      capability: "TEXT_GENERATION",
    });
    if (staleText.admitted) await fakeProvider();
    expect(fakeProvider).not.toHaveBeenCalled();
    expect(staleText.blockers).toEqual(["CREATOR_PROFILE_REVISION_STALE"]);

    const concurrentBody = {
      ...afterRevoke.body.revision.editableRevision,
      expectedRevision: 4,
    };
    const concurrent = await Promise.all([
      request(app.getHttpServer())
        .put(`/api/v1/creator-profiles/${created.body.id}`)
        .set("Idempotency-Key", key("profile-concurrent-a"))
        .send({ ...concurrentBody, canonicalDisplayName: "Победитель A" }),
      request(app.getHttpServer())
        .put(`/api/v1/creator-profiles/${created.body.id}`)
        .set("Idempotency-Key", key("profile-concurrent-b"))
        .send({ ...concurrentBody, canonicalDisplayName: "Победитель B" }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(await prisma.pipelineJob.count()).toBe(jobsAfterContext);
    expect(await prisma.jobAttempt.count()).toBe(attemptsBefore);
  });

  it("gives one authoritative object to concurrent identical upload requests", async () => {
    const profile = await request(app.getHttpServer())
      .post("/api/v1/creator-profiles")
      .set("Idempotency-Key", key("race-profile"))
      .send({
        canonicalDisplayName: "Upload Race",
        officialUrl: `https://example.com/${marker}/upload-race`,
        primaryLanguage: "ru",
        topics: [],
        editorialNotes: "private",
        restrictions: [],
      })
      .expect(201);
    profileIds.push(profile.body.id);
    const directory = await mkdtemp(join(tmpdir(), "creator-upload-race-"));
    const firstPath = join(directory, "first.png");
    const secondPath = join(directory, "second.png");
    const bytes = png(2, 2);
    await Promise.all([
      writeFile(firstPath, bytes, { mode: 0o600 }),
      writeFile(secondPath, bytes, { mode: 0o600 }),
    ]);
    const objects = new Map<string, Buffer>();
    const putKeys: string[] = [];
    const storage = {
      putFile: async (input: { objectKey: string; filePath: string }) => {
        putKeys.push(input.objectKey);
        await delay(75);
        objects.set(input.objectKey, await readFile(input.filePath));
        return { etag: "one-etag" };
      },
      deleteObject: async (objectKey: string) => {
        objects.delete(objectKey);
      },
    } as unknown as CreatorContextStorage;
    const repository = new PrismaCreatorContextRepository(
      prisma,
      {} as never,
      {} as never,
    );
    const service = new CreatorContextService(
      repository,
      storage,
      new StructuralReferenceImageInspector(),
    );
    const upload = (filePath: string) =>
      service.uploadReference({
        creatorProfileId: profile.body.id,
        idempotencyKey: key("concurrent-reference-upload"),
        originalFilename: "same.png",
        declaredContentType: "image/png",
        filePath,
      });

    const [first, second] = await Promise.all([
      upload(firstPath),
      upload(secondPath),
    ]);

    expect(first).toEqual(second);
    expect(first.status).toBe("READY");
    expect(putKeys).toEqual([expect.any(String)]);
    expect(objects.size).toBe(1);
    const rows = await prisma.creatorReferenceAsset.findMany({
      where: { creatorProfileId: profile.body.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      objectKey: putKeys[0],
      status: "READY",
      cleanupStatus: "NOT_REQUIRED",
    });
    expect(
      await prisma.aiContentOperationRequest.count({
        where: { idempotencyKey: key("concurrent-reference-upload") },
      }),
    ).toBe(1);
    await rm(directory, { recursive: true, force: true });
  });

  async function readyCut(): Promise<{
    projectId: string;
    sourceId: string;
    jobId: string;
  }> {
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    projectIds.push(projectId);
    await prisma.$transaction(async (transaction) => {
      await transaction.project.create({
        data: {
          id: projectId,
          idempotencyKey: key(`project-${projectId}`),
          requestFingerprint: marker,
          name: "Creator context integration",
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
          durationMs: 1_800_000,
        },
      });
      await transaction.sourceAuthorization.create({
        data: {
          sourceId,
          sourceVersion: 1,
          status: "CLEARED",
          basis: "OPERATOR_ATTESTATION",
          declarationVersion: "source-authorization-v1",
          decidedAt: new Date(),
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
          idempotencyKey: key(`job-${jobId}`),
          recipeVersion: "stage1-cut-h264-v2",
        },
      });
      await transaction.mediaArtifact.create({
        data: {
          id: randomUUID(),
          projectId,
          sourceId,
          role: "CUT_RESULT",
          status: "READY",
          objectKey: `test/${marker}/${jobId}.mp4`,
          sizeBytes: 500n,
          sha256: "b".repeat(64),
          contentType: "video/mp4",
          lineageSourceId: sourceId,
          lineageSourceVersion: 1,
          recipeVersion: "stage1-cut-h264-v2",
          pipelineJobId: jobId,
        },
      });
    });
    return { projectId, sourceId, jobId };
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
