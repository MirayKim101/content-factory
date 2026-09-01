export type ProjectStatus = "SOURCE_PENDING" | "SOURCE_READY" | "FAILED_FINAL";
export type SourceStatus = "PENDING" | "READY" | "FAILED_FINAL";
export type ArtifactStatus = "PENDING" | "READY" | "FAILED_FINAL";

export interface ProjectView {
  id: string;
  name: string;
  status: ProjectStatus;
  rightsConfirmedAt: Date;
  rightsDeclarationVersion: string;
  failure?: { code: string; message: string };
  createdAt: Date;
  updatedAt: Date;
  source: {
    id: string;
    status: SourceStatus;
    sourceVersion: number;
    originalFilename: string;
    contentType: string;
    sizeBytes: bigint;
    sha256: string;
  };
  artifact: {
    id: string;
    role: "SOURCE";
    status: ArtifactStatus;
    sizeBytes: bigint;
    sha256: string;
    contentType: string;
    lineageSourceId: string;
    lineageSourceVersion: number;
    recipeVersion: string;
  };
}

export interface PendingUpload {
  projectId: string;
  sourceId: string;
  artifactId: string;
  objectKey: string;
  expectedSizeBytes: bigint;
  expectedSha256: string;
  createdAt: Date;
}

export interface PendingCleanup {
  projectId: string;
  artifactId: string;
  objectKey: string;
}
