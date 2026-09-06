export const ASSEMBLY_SCHEMA_VERSION = "horizontal-assembly-v1" as const;
export const ASSEMBLY_AUDIO_PROFILE = "youtube-stereo-v1" as const;
export const ASSEMBLY_ENCODING_PROFILE = "youtube-h264-v1" as const;
export const ASSEMBLY_POSITIONS = [
  "TOP_LEFT",
  "TOP_RIGHT",
  "BOTTOM_LEFT",
  "BOTTOM_RIGHT",
] as const;

export type AssemblyPosition = (typeof ASSEMBLY_POSITIONS)[number];

export interface AssemblyRecipeConfiguration {
  introAssetId: string | null;
  outroAssetId: string | null;
  advertisement: { assetId: string; insertAtMs: number } | null;
  banners: Array<{
    clientItemId: string;
    assetId: string;
    startMs: number;
    endMs: number;
    position: AssemblyPosition;
  }>;
  cta: {
    text: string;
    startMs: number;
    endMs: number;
    position: AssemblyPosition;
  } | null;
  audioProfileVersion: typeof ASSEMBLY_AUDIO_PROFILE;
  encodingProfileVersion: typeof ASSEMBLY_ENCODING_PROFILE;
}

export interface AssemblyAssetSnapshot {
  id: string;
  revision: number;
  sha256: string;
  sizeBytes: bigint;
  kind: "ADVERTISEMENT" | "INTRO" | "OUTRO" | "BANNER";
  durationMs: number | null;
}

export interface AssemblyRecipeView {
  id: string;
  projectId: string;
  pipelineJobId: string;
  cutResultArtifact: {
    id: string;
    sha256: string;
    sizeBytes: bigint;
    sourceId: string;
    sourceVersion: number;
    recipeVersion: string;
    durationMs: number;
  };
  revision: {
    id: string;
    revision: number;
    schemaVersion: typeof ASSEMBLY_SCHEMA_VERSION;
    configurationFingerprint: string;
    configuration: AssemblyRecipeConfiguration;
    assets: {
      intro: AssemblyAssetSnapshot | null;
      outro: AssemblyAssetSnapshot | null;
      advertisement: AssemblyAssetSnapshot | null;
      banners: AssemblyAssetSnapshot[];
    };
    createdAt: Date;
  };
  validation: { valid: true };
  createdAt: Date;
  updatedAt: Date;
}

export class AssemblyRecipeIdempotencyConflictError extends Error {}
export class AssemblyRecipeRevisionConflictError extends Error {}
export class AssemblyRecipeNotFoundError extends Error {}
export class AssemblyRecipeProjectNotFoundError extends Error {}
export class AssemblyRecipeCutNotReadyError extends Error {}
export class AssemblyRecipeCutLineageInvalidError extends Error {}
export class AssemblyRecipeAssetNotFoundError extends Error {}
export class AssemblyRecipeAssetInvalidError extends Error {}
export class AssemblyRecipeAssetRightsError extends Error {}
export class AssemblyRecipeConfigurationError extends Error {}
export class AssemblyRecipeCursorInvalidError extends Error {}
export class AssemblyRecipePersistenceError extends Error {}
