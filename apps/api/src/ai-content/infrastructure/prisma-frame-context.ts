import { createHash } from "node:crypto";
import {
  frameContextBlockers,
  framePolicyMaterial,
  type FrameContextCapture,
  type FrameContextFacts,
} from "@content-factory/contracts";
import type { Prisma } from "../../generated/prisma/client.js";

export interface FrameContextSelection {
  cutPipelineJobId: string;
  sourceContextRevisionId: string;
  cutPromptRevisionId: string;
}

/** Invoked only inside the owning SERIALIZABLE transaction. No detached
 * resolver can authorize admission, a first byte read, or final acceptance.
 */
export async function lockedFrameContext(
  transaction: Prisma.TransactionClient,
  selection: FrameContextSelection,
): Promise<FrameContextFacts | null> {
  const hint = await transaction.cutEditorialPromptRevision.findUnique({
    where: { id: selection.cutPromptRevisionId },
    include: { prompt: true, sourceContextRevision: true },
  });
  if (
    !hint ||
    hint.prompt.cutPipelineJobId !== selection.cutPipelineJobId ||
    hint.sourceContextRevisionId !== selection.sourceContextRevisionId
  )
    return null;
  const context = hint.sourceContextRevision;
  // Frozen global current-row lock order. An upstream writer committed after
  // our snapshot makes PostgreSQL abort this transaction; the owner retries it.
  await transaction.$queryRaw`SELECT "id" FROM "VideoSource" WHERE "id" = ${hint.sourceId}::uuid FOR SHARE`;
  await transaction.$queryRaw`SELECT "sourceId" FROM "SourceAuthorization" WHERE "sourceId" = ${hint.sourceId} AND "sourceVersion" = ${hint.sourceVersion} FOR SHARE`;
  await transaction.$queryRaw`SELECT "id" FROM "PipelineJob" WHERE "id" = ${selection.cutPipelineJobId}::uuid FOR SHARE`;
  await transaction.$queryRaw`SELECT "id" FROM "MediaArtifact" WHERE "id" = ${hint.prompt.cutResultArtifactId}::uuid FOR SHARE`;
  await transaction.$queryRaw`SELECT "id" FROM "CreatorProfile" WHERE "id" = ${context.creatorProfileId}::uuid FOR SHARE`;
  await transaction.$queryRaw`SELECT "id" FROM "SourceEditorialContext" WHERE "id" = ${context.contextId}::uuid FOR SHARE`;
  await transaction.$queryRaw`SELECT "id" FROM "CutEditorialPrompt" WHERE "id" = ${hint.promptId}::uuid FOR SHARE`;
  const cut = await transaction.pipelineJob.findUnique({
    where: { id: selection.cutPipelineJobId },
    include: {
      source: { include: { authorizations: true } },
      resultArtifact: true,
      segment: true,
    },
  });
  const row = await transaction.cutEditorialPromptRevision.findUnique({
    where: { id: selection.cutPromptRevisionId },
    include: {
      prompt: true,
      sourceContextRevision: {
        include: { context: true, creatorProfile: true },
      },
    },
  });
  if (!cut || !row || !cut.resultArtifact || !cut.segment) return null;
  const sourceContext = row.sourceContextRevision;
  const authorization = cut.source.authorizations.find(
    (item) => item.sourceVersion === cut.sourceVersion,
  );
  const artifact = cut.resultArtifact;
  const capture: FrameContextCapture = {
    projectId: cut.projectId,
    sourceId: cut.sourceId,
    sourceVersion: cut.sourceVersion,
    sourceSha256: cut.source.sha256,
    sourceAuthorizationRevision: authorization?.revision ?? 0,
    sourceAuthorizationBasis: authorization?.basis ?? "",
    sourceAuthorizationDeclarationVersion:
      authorization?.declarationVersion ?? "",
    sourceAuthorizationDecidedAt: authorization?.decidedAt?.toISOString() ?? "",
    cutPipelineJobId: cut.id,
    cutResultArtifactId: artifact.id,
    cutResultSha256: artifact.sha256,
    cutResultSizeBytes: artifact.sizeBytes.toString(),
    cutStartMs: cut.segment.startMs,
    cutEndMs: cut.segment.endMs,
    creatorProfileId: sourceContext.creatorProfileId,
    creatorProfileRevisionId: sourceContext.creatorProfileRevisionId,
    creatorProfileRevisionNo: sourceContext.creatorProfileRevisionNo,
    sourceContextId: sourceContext.contextId,
    sourceContextRevisionId: sourceContext.id,
    sourceContextRevisionNo: sourceContext.revision,
    cutPromptId: row.promptId,
    cutPromptRevisionId: row.id,
    cutPromptRevisionNo: row.revision,
  };
  return {
    capture,
    sourceStatus: cut.source.status,
    sourceCurrentVersion: cut.source.sourceVersion,
    sourceAuthorizationStatus: authorization?.status ?? null,
    cutJobType: cut.type,
    cutJobState: cut.state,
    cutArtifactRole: artifact.role,
    cutArtifactStatus: artifact.status,
    creatorProfileCurrentRevision: sourceContext.creatorProfile.currentRevision,
    sourceContextCurrentRevision: sourceContext.context.currentRevision,
    cutPromptCurrentRevision: row.prompt.currentRevision,
    exactLineage:
      cut.source.projectId === cut.projectId &&
      artifact.pipelineJobId === cut.id &&
      artifact.projectId === cut.projectId &&
      artifact.lineageSourceId === cut.sourceId &&
      artifact.lineageSourceVersion === cut.sourceVersion &&
      row.projectId === cut.projectId &&
      row.sourceId === cut.sourceId &&
      row.sourceVersion === cut.sourceVersion &&
      row.prompt.cutResultArtifactId === artifact.id &&
      row.prompt.cutResultSha256 === artifact.sha256 &&
      row.prompt.cutResultSizeBytes === artifact.sizeBytes &&
      sourceContext.projectId === cut.projectId &&
      sourceContext.sourceId === cut.sourceId &&
      sourceContext.sourceVersion === cut.sourceVersion,
  };
}

export function frameContextFingerprint(capture: FrameContextCapture): string {
  return createHash("sha256")
    .update(framePolicyMaterial(capture))
    .digest("hex");
}

export function requireFrameContext(
  facts: FrameContextFacts | null,
  policy: "manual" | "local-auto",
  captured?: FrameContextCapture,
): FrameContextFacts {
  if (!facts) throw new FrameContextRejectedError(["CUT_LINEAGE_UNUSABLE"]);
  const blockers = frameContextBlockers(facts, policy, captured);
  if (blockers.length) throw new FrameContextRejectedError(blockers);
  return facts;
}

export class FrameContextRejectedError extends Error {
  constructor(readonly blockers: readonly string[]) {
    super("FRAME_CONTEXT_REQUIRED");
  }
}
