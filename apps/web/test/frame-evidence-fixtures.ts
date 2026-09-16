import type { FrameEvidence, FrameScope } from "~/shared/api/frame-evidence";
import { ids } from "./creator-context-fixtures";
export const scope: FrameScope = {
  projectId: ids.a,
  sourceId: ids.source,
  sourceVersion: 1,
  cutPipelineJobId: ids.job,
};
export const frameBody = {
  sourceContextRevisionId: ids.context,
  cutPromptRevisionId: ids.prompt,
};
export function evidence(
  state: FrameEvidence["job"]["state"] = "READY",
): FrameEvidence {
  return {
    id: ids.b,
    pipelineJobId: ids.auth,
    createdAt: "2026-09-16T00:00:00.000Z",
    identity: {
      ...scope,
      sourceSha256: "a".repeat(64),
      sourceAuthorizationRevision: 1,
      sourceAuthorizationBasis: "OWNER",
      sourceAuthorizationDeclarationVersion: "source-authorization-v1",
      sourceAuthorizationDecidedAt: "2026-09-16T00:00:00.000Z",
      cutResultArtifactId: ids.job,
      cutResultSha256: "b".repeat(64),
      cutResultSizeBytes: "10000",
      cutStartMs: 1000,
      cutEndMs: 5000,
      creatorProfileId: ids.a,
      creatorProfileRevisionId: ids.a,
      creatorProfileRevisionNo: 1,
      sourceContextId: ids.context,
      sourceContextRevisionId: ids.context,
      sourceContextRevisionNo: 1,
      cutPromptId: ids.prompt,
      cutPromptRevisionId: ids.prompt,
      cutPromptRevisionNo: 1,
    },
    contractVersion: "editorial-sparse-frames-v1",
    recipeVersion: "quartiles-jpeg-640-v1",
    requestedPositionsMs: [1000, 2000, 3000],
    currentUse: {
      usableForGeneration: state === "READY",
      blockers: [],
      contextPolicyFingerprint: "a".repeat(64),
    },
    contentAccess: { bytesReadable: true, blocker: null },
    job: {
      state,
      revision: 1,
      attempt: state === "QUEUED" ? 0 : 1,
      nextAttemptAt: null,
      admissionReason: null,
      failure: null,
      progress:
        state === "PROCESSING"
          ? {
              schemaVersion: "editorial-frame-progress-v1",
              phase: "EXTRACT",
              completedFrameCount: 1,
              basisPoints: 3500,
            }
          : null,
    },
    frames:
      state === "READY"
        ? [ids.asset, ids.context, ids.prompt].map((id, ordinal) => ({
            id,
            measurement: {
              ordinal,
              requestedCutMs: (ordinal + 1) * 1000,
              requestedSourceMs: (ordinal + 2) * 1000,
              actualPtsTicks: (ordinal + 1) * 1000000 + 40000,
              actualCutMs: (ordinal + 1) * 1000 + 40,
              mappedSourceMs: (ordinal + 2) * 1000 + 40,
              timeBaseNumerator: 1,
              timeBaseDenominator: 1000000,
              width: 640,
              height: 360,
              sizeBytes: 1234,
              sha256: "c".repeat(64),
              contentType: "image/jpeg",
              recipeVersion: "quartiles-jpeg-640-v1",
              extractorVersion: "ffmpeg-frame-extractor-v1",
              ffmpegVersion: "5.1.9",
            },
          }))
        : [],
  };
}
