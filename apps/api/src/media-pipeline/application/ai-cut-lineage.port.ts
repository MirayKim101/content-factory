export const AI_CUT_LINEAGE = Symbol("AI_CUT_LINEAGE");

export type ReadyCutLineage = {
  cutPipelineJobId: string;
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  resultArtifactId: string;
  resultSha256: string;
  resultSizeBytes: bigint;
  sourceSha256: string;
  authorizationRevision: number;
  authorizationBasis: string;
  authorizationDeclarationVersion: string;
  authorizationDecidedAt: Date;
};

export interface AiCutLineagePort {
  resolveReadyCut(cutPipelineJobId: string): Promise<ReadyCutLineage | null>;
}
