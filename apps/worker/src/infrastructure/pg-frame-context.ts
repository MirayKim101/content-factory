import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  frameContextBlockers,
  framePolicyMaterial,
  type FrameContextCapture,
  type FrameContextFacts,
} from "@content-factory/contracts";
import { ControlledMediaError } from "../domain/media-job.js";

/** Worker-owned adapter. Uses only the shared pure policy, never API internals. */
export async function lockedWorkerFrameContext(
  client: PoolClient,
  captured: FrameContextCapture,
  policy: "manual" | "local-auto",
): Promise<string> {
  await client.query('SELECT "id" FROM "VideoSource" WHERE "id"=$1 FOR SHARE', [
    captured.sourceId,
  ]);
  await client.query(
    'SELECT "sourceId" FROM "SourceAuthorization" WHERE "sourceId"=$1 AND "sourceVersion"=$2 FOR SHARE',
    [captured.sourceId, captured.sourceVersion],
  );
  await client.query('SELECT "id" FROM "PipelineJob" WHERE "id"=$1 FOR SHARE', [
    captured.cutPipelineJobId,
  ]);
  await client.query(
    'SELECT "id" FROM "MediaArtifact" WHERE "id"=$1 FOR SHARE',
    [captured.cutResultArtifactId],
  );
  await client.query(
    'SELECT "id" FROM "CreatorProfile" WHERE "id"=$1 FOR SHARE',
    [captured.creatorProfileId],
  );
  await client.query(
    'SELECT "id" FROM "SourceEditorialContext" WHERE "id"=$1 FOR SHARE',
    [captured.sourceContextId],
  );
  await client.query(
    'SELECT "id" FROM "CutEditorialPrompt" WHERE "id"=$1 FOR SHARE',
    [captured.cutPromptId],
  );
  const result = await client.query<{ facts: FrameContextFacts }>(
    `
    SELECT json_build_object(
      'capture', json_build_object(
        'projectId', j."projectId", 'sourceId', j."sourceId", 'sourceVersion', j."sourceVersion",
        'sourceSha256', s."sha256", 'sourceAuthorizationRevision', coalesce(a."revision",0),
        'sourceAuthorizationBasis', coalesce(a."basis"::text,''),
        'sourceAuthorizationDeclarationVersion', coalesce(a."declarationVersion",''),
        'sourceAuthorizationDecidedAt', coalesce(to_char(a."decidedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),''),
        'cutPipelineJobId', j."id", 'cutResultArtifactId', m."id",
        'cutResultSha256', m."sha256", 'cutResultSizeBytes', m."sizeBytes"::text,
        'cutStartMs', seg."startMs", 'cutEndMs', seg."endMs",
        'creatorProfileId', cr."creatorProfileId", 'creatorProfileRevisionId', cr."creatorProfileRevisionId",
        'creatorProfileRevisionNo', cr."creatorProfileRevisionNo",
        'sourceContextId', cr."contextId", 'sourceContextRevisionId', cr."id", 'sourceContextRevisionNo', cr."revision",
        'cutPromptId', pr."promptId", 'cutPromptRevisionId', pr."id", 'cutPromptRevisionNo', pr."revision"
      ),
      'sourceStatus', s."status", 'sourceCurrentVersion', s."sourceVersion", 'sourceAuthorizationStatus', a."status",
      'cutJobType', j."type", 'cutJobState', j."state", 'cutArtifactRole', m."role", 'cutArtifactStatus', m."status",
      'creatorProfileCurrentRevision', cp."currentRevision", 'sourceContextCurrentRevision', c."currentRevision",
      'cutPromptCurrentRevision', p."currentRevision",
      'exactLineage', s."projectId"=j."projectId" AND m."projectId"=j."projectId"
        AND m."lineageSourceId"=j."sourceId" AND m."lineageSourceVersion"=j."sourceVersion"
        AND p."cutPipelineJobId"=j."id" AND p."cutResultArtifactId"=m."id"
        AND p."cutResultSha256"=m."sha256" AND p."cutResultSizeBytes"=m."sizeBytes"
        AND pr."projectId"=j."projectId" AND pr."sourceId"=j."sourceId" AND pr."sourceVersion"=j."sourceVersion"
        AND cr."projectId"=j."projectId" AND cr."sourceId"=j."sourceId" AND cr."sourceVersion"=j."sourceVersion"
    ) AS facts
    FROM "PipelineJob" j
    JOIN "VideoSource" s ON s."id"=j."sourceId"
    LEFT JOIN "SourceAuthorization" a ON a."sourceId"::text=s."id"::text AND a."sourceVersion"=j."sourceVersion"
    JOIN "MediaArtifact" m ON m."pipelineJobId"=j."id"
    JOIN "CutSegment" seg ON seg."jobId"=j."id"
    JOIN "CutEditorialPromptRevision" pr ON pr."id"=$2
    JOIN "CutEditorialPrompt" p ON p."id"=pr."promptId"
    JOIN "SourceEditorialContextRevision" cr ON cr."id"=pr."sourceContextRevisionId" AND cr."id"=$3
    JOIN "SourceEditorialContext" c ON c."id"=cr."contextId"
    JOIN "CreatorProfile" cp ON cp."id"=cr."creatorProfileId"
    WHERE j."id"=$1`,
    [
      captured.cutPipelineJobId,
      captured.cutPromptRevisionId,
      captured.sourceContextRevisionId,
    ],
  );
  const facts = result.rows[0]?.facts;
  const blockers = facts
    ? frameContextBlockers(facts, policy, captured)
    : ["CUT_LINEAGE_UNUSABLE"];
  if (blockers.length || !facts)
    throw new ControlledMediaError(
      "FRAME_CONTEXT_STALE",
      "Контекст или разрешение источника изменились.",
      false,
    );
  return createHash("sha256")
    .update(framePolicyMaterial(facts.capture))
    .digest("hex");
}

export function workerFrameCapture(
  row: Record<string, unknown>,
): FrameContextCapture {
  return {
    projectId: String(row.projectId),
    sourceId: String(row.sourceId),
    sourceVersion: Number(row.sourceVersion),
    sourceSha256: String(row.sourceSha256),
    sourceAuthorizationRevision: Number(row.sourceAuthorizationRevision),
    sourceAuthorizationBasis: String(row.sourceAuthorizationBasis),
    sourceAuthorizationDeclarationVersion: String(
      row.sourceAuthorizationDeclarationVersion,
    ),
    sourceAuthorizationDecidedAt: new Date(
      row.sourceAuthorizationDecidedAt as string | Date,
    ).toISOString(),
    cutPipelineJobId: String(row.cutPipelineJobId),
    cutResultArtifactId: String(row.cutResultArtifactId),
    cutResultSha256: String(row.cutResultSha256),
    cutResultSizeBytes: String(row.cutResultSizeBytes),
    cutStartMs: Number(row.cutStartMs),
    cutEndMs: Number(row.cutEndMs),
    creatorProfileId: String(row.creatorProfileId),
    creatorProfileRevisionId: String(row.creatorProfileRevisionId),
    creatorProfileRevisionNo: Number(row.creatorProfileRevisionNo),
    sourceContextId: String(row.sourceContextId),
    sourceContextRevisionId: String(row.sourceContextRevisionId),
    sourceContextRevisionNo: Number(row.sourceContextRevisionNo),
    cutPromptId: String(row.cutPromptId),
    cutPromptRevisionId: String(row.cutPromptRevisionId),
    cutPromptRevisionNo: Number(row.cutPromptRevisionNo),
  };
}
