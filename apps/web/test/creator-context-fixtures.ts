export const ids = {
  a: "00000000-0000-4000-8000-000000000001",
  b: "00000000-0000-4000-8000-000000000002",
  asset: "00000000-0000-4000-8000-000000000003",
  auth: "00000000-0000-4000-8000-000000000004",
  context: "00000000-0000-4000-8000-000000000005",
  prompt: "00000000-0000-4000-8000-000000000006",
  job: "00000000-0000-4000-8000-000000000007",
  source: "00000000-0000-4000-8000-000000000008",
};
const time = "2026-09-16T00:00:00.000Z";
export function profile(id = ids.a, revision = 1) {
  return {
    id,
    currentRevision: revision,
    createdAt: time,
    updatedAt: time,
    revision: {
      id,
      profileId: id,
      revision,
      editableRevision: {
        canonicalDisplayName: id === ids.a ? "Creator A" : "Creator B",
        officialUrl: `https://example.com/${id}`,
        primaryLanguage: "ru",
        topics: ["Game"],
        editorialNotes: `Private notes ${id}`,
        restrictions: ["Private restriction"],
      },
      likenessPolicy: "NO_REALISTIC_LIKENESS" as
        "NO_REALISTIC_LIKENESS" | "CLEARED_REFERENCE_ONLY",
      likenessUsability: {
        usable: false,
        blocker: "NO_DEFAULT_REFERENCE" as string | null,
        externalProviderTransferAllowed: false,
      },
      defaultReference: null as null | {
        assetId: string;
        authorizationRevisionId: string;
        authorizationRevision: number;
        authorizationStatus: "CLEARED";
        expiresAt: null;
        externalProviderTransferAllowed: boolean;
      },
      status: "CURRENT" as const,
      officialUrlIdentity: {},
      createdAt: time,
    },
  };
}
export function reference(
  status: "NOT_REVIEWED" | "CLEARED" | "REVOKED" = "NOT_REVIEWED",
  revision = 1,
) {
  return {
    id: ids.asset,
    creatorProfileId: ids.a,
    originalFilename: "photo.png",
    contentType: "image/png" as const,
    sizeBytes: "10",
    sha256: "a".repeat(64),
    width: 1,
    height: 1,
    status: "READY" as const,
    createdAt: time,
    updatedAt: time,
    currentAuthorization: {
      id: ids.auth,
      revision,
      status,
      commercialAiImageUseAttested: status === "CLEARED",
      externalProviderTransferAllowed: false,
      basis: null,
      scope: null,
      declarationVersion: null,
      expiresAt: null,
      createdAt: time,
      decidedAt: null,
    },
  };
}
export function context(revision = 1, sourceVersion = 1) {
  return {
    id: ids.context,
    currentRevision: revision,
    createdAt: time,
    updatedAt: time,
    revision: {
      id: ids.context,
      contextId: ids.context,
      revision,
      projectId: ids.a,
      sourceId: ids.source,
      sourceVersion,
      creatorProfileRevisionId: ids.a,
      editableRevision: {
        creatorProfileId: ids.a,
        creatorProfileRevision: 1,
        sourceTitle: "Source",
        gameOrTopic: "Game",
        audience: "Audience",
        editorialGoal: "Goal",
        language: "ru",
        defaultCta: "CTA",
        restrictions: ["Context restriction"],
        operatorNotes: "Private source notes",
      },
      blockers: [] as string[],
      likenessUsability: {
        usable: false,
        blocker: "NO_DEFAULT_REFERENCE",
        externalProviderTransferAllowed: false,
      },
      status: "CURRENT" as "CURRENT" | "STALE",
      createdAt: time,
    },
  };
}
export function prompt(revision = 1) {
  return {
    id: ids.prompt,
    currentRevision: revision,
    createdAt: time,
    updatedAt: time,
    revision: {
      id: ids.prompt,
      promptId: ids.prompt,
      revision,
      projectId: ids.a,
      sourceId: ids.source,
      sourceVersion: 1,
      cutPipelineJobId: ids.job,
      sourceContextRevisionId: ids.context,
      editableRevision: {
        sourceContextId: ids.context,
        sourceContextRevision: 1,
        whatHappens: "A funny moment",
        desiredAngle: "Funny",
        tone: "Kind",
        cta: "CTA",
        restrictions: ["Prompt restriction"],
      },
      blockers: [] as string[],
      likenessUsability: {
        usable: false,
        blocker: "NO_DEFAULT_REFERENCE",
        externalProviderTransferAllowed: false,
      },
      contextPolicyFingerprint: "a".repeat(64),
      status: "CURRENT" as "CURRENT" | "STALE",
      createdAt: time,
      cutResultArtifact: {
        id: ids.job,
        sha256: "a".repeat(64),
        sizeBytes: "10",
      },
    },
  };
}
export function summary(id = ids.a) {
  const p = profile(id);
  return {
    id,
    canonicalDisplayName: p.revision.editableRevision.canonicalDisplayName,
    officialUrl: p.revision.editableRevision.officialUrl,
    primaryLanguage: "ru",
    topics: ["Game"],
    currentRevision: 1,
    likenessAllowed: false,
    likenessPolicy: "NO_REALISTIC_LIKENESS" as const,
    updatedAt: time,
  };
}
