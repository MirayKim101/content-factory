import { randomUUID } from "node:crypto";
import type { PrismaService } from "../../src/database/prisma.service.js";

export async function seedFrameContext(prisma: PrismaService) {
  const projectId = randomUUID();
  const sourceId = randomUUID();
  const cutJobId = randomUUID();
  const artifactId = randomUUID();
  const profileId = randomUUID();
  const profileRevisionId = randomUUID();
  const identityId = randomUUID();
  const contextId = randomUUID();
  const contextRevisionId = randomUUID();
  const promptId = randomUUID();
  const promptRevisionId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.project.create({
      data: {
        id: projectId,
        idempotencyKey: projectId,
        requestFingerprint: projectId,
        name: "frame-integration",
        status: "SOURCE_READY",
      },
    });
    await tx.videoSource.create({
      data: {
        id: sourceId,
        projectId,
        status: "READY",
        sourceVersion: 1,
        originalFilename: "synthetic.mp4",
        contentType: "video/mp4",
        sizeBytes: 1024n,
        sha256: "a".repeat(64),
        durationMs: 10000,
      },
    });
    await tx.sourceAuthorization.create({
      data: {
        sourceId,
        sourceVersion: 1,
        status: "CLEARED",
        basis: "OPERATOR_ATTESTATION",
        declarationVersion: "source-rights-v1",
        decidedAt: new Date("2026-09-16T00:00:00.000Z"),
      },
    });
    await tx.pipelineJob.create({
      data: {
        id: cutJobId,
        projectId,
        sourceId,
        sourceVersion: 1,
        type: "CUT_SEGMENT",
        state: "READY",
        idempotencyKey: cutJobId,
        recipeVersion: "stage1-cut-h264-v2",
        segment: {
          create: {
            id: randomUUID(),
            clientSegmentId: "one",
            startMs: 1000,
            endMs: 4000,
          },
        },
      },
    });
    await tx.mediaArtifact.create({
      data: {
        id: artifactId,
        projectId,
        sourceId,
        role: "CUT_RESULT",
        status: "READY",
        objectKey: `test/frame-input/${artifactId}`,
        sizeBytes: 512n,
        sha256: "b".repeat(64),
        contentType: "video/mp4",
        lineageSourceId: sourceId,
        lineageSourceVersion: 1,
        recipeVersion: "stage1-cut-h264-v2",
        pipelineJobId: cutJobId,
      },
    });
    await tx.creatorProfile.create({ data: { id: profileId } });
    await tx.creatorProfileOfficialUrlIdentity.create({
      data: {
        id: identityId,
        creatorProfileId: profileId,
        canonicalUrl: `https://example.com/${profileId}`,
      },
    });
    await tx.creatorProfileRevision.create({
      data: {
        id: profileRevisionId,
        creatorProfileId: profileId,
        revision: 1,
        canonicalDisplayName: "Synthetic creator",
        officialUrlIdentityId: identityId,
        officialUrl: `https://example.com/${profileId}`,
        primaryLanguage: "ru",
        topics: [],
        editorialNotes: "",
        restrictions: [],
      },
    });
    await tx.sourceEditorialContext.create({
      data: { id: contextId, projectId, sourceId, sourceVersion: 1 },
    });
    await tx.sourceEditorialContextRevision.create({
      data: {
        id: contextRevisionId,
        contextId,
        revision: 1,
        projectId,
        sourceId,
        sourceVersion: 1,
        creatorProfileId: profileId,
        creatorProfileRevisionId: profileRevisionId,
        creatorProfileRevisionNo: 1,
        sourceTitle: "Synthetic",
        gameOrTopic: "fixture",
        audience: "fixture",
        editorialGoal: "fixture",
        language: "ru",
        defaultCta: "",
        restrictions: [],
        operatorNotes: "",
      },
    });
    await tx.cutEditorialPrompt.create({
      data: {
        id: promptId,
        cutPipelineJobId: cutJobId,
        projectId,
        sourceId,
        sourceVersion: 1,
        cutResultArtifactId: artifactId,
        cutResultSha256: "b".repeat(64),
        cutResultSizeBytes: 512n,
      },
    });
    await tx.cutEditorialPromptRevision.create({
      data: {
        id: promptRevisionId,
        promptId,
        revision: 1,
        projectId,
        sourceId,
        sourceVersion: 1,
        sourceContextId: contextId,
        sourceContextRevisionId: contextRevisionId,
        sourceContextRevisionNo: 1,
        whatHappens: "fixture",
        desiredAngle: "fixture",
        tone: "fixture",
        cta: "",
        restrictions: [],
      },
    });
  });
  return {
    projectId,
    sourceId,
    cutJobId,
    artifactId,
    profileId,
    profileRevisionId,
    contextId,
    contextRevisionId,
    promptId,
    promptRevisionId,
  };
}

export async function clearFrameFixtures(
  prisma: PrismaService,
  projectIds: string[],
  profileIds: string[],
) {
  const intents = await prisma.frameEvidenceIntent.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true },
  });
  const intentIds = intents.map((intent) => intent.id);
  const attempts = await prisma.frameEvidenceAttempt.findMany({
    where: { intentId: { in: intentIds } },
    select: { id: true },
  });
  const attemptIds = attempts.map((attempt) => attempt.id);
  await prisma.frameExtractionSlot.updateMany({
    where: { attemptId: { in: attemptIds } },
    data: {
      attemptId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      workDeadlineAt: null,
    },
  });
  await prisma.frameEvidenceFrame.deleteMany({
    where: { intentId: { in: intentIds } },
  });
  await prisma.frameEvidenceResult.deleteMany({
    where: { intentId: { in: intentIds } },
  });
  await prisma.frameEvidenceAttemptOutput.deleteMany({
    where: { intentId: { in: intentIds } },
  });
  await prisma.frameEvidenceAttempt.deleteMany({
    where: { intentId: { in: intentIds } },
  });
  await prisma.frameEvidenceIntent.deleteMany({
    where: { id: { in: intentIds } },
  });
  await prisma.aiContentOperationRequest.deleteMany({
    where: { resolvedProjectId: { in: projectIds } },
  });
  await prisma.cutEditorialPromptRevision.deleteMany({
    where: { projectId: { in: projectIds } },
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
  await prisma.creatorProfileOfficialUrlIdentity.deleteMany({
    where: { creatorProfileId: { in: profileIds } },
  });
  await prisma.creatorProfile.deleteMany({ where: { id: { in: profileIds } } });
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
