export const AI_SOURCE_LINEAGE = Symbol("AI_SOURCE_LINEAGE");

export type AuthorizedSourceLineage = {
  projectId: string;
  sourceId: string;
  sourceVersion: number;
  sourceSha256: string;
  authorizationRevision: number;
  authorizationBasis: string;
  authorizationDeclarationVersion: string;
  authorizationDecidedAt: Date;
};

export interface AiSourceLineagePort {
  resolveAuthorizedSource(
    projectId: string,
    sourceId: string,
    sourceVersion: number,
  ): Promise<AuthorizedSourceLineage | null>;
}
