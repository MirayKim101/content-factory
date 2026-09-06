import type { AssemblyRecipeView } from "../domain/assembly-recipe.js";
import type { AssemblyRecipeResponseDto } from "./assembly-recipe.dto.js";

export function assemblyRecipeResponse(
  value: AssemblyRecipeView,
): AssemblyRecipeResponseDto {
  const mapAsset = (
    asset: AssemblyRecipeView["revision"]["assets"]["intro"],
  ) =>
    asset
      ? {
          ...asset,
          sizeBytes: asset.sizeBytes.toString(),
        }
      : null;
  return {
    id: value.id,
    projectId: value.projectId,
    pipelineJobId: value.pipelineJobId,
    cutResultArtifact: {
      ...value.cutResultArtifact,
      sizeBytes: value.cutResultArtifact.sizeBytes.toString(),
    },
    revision: {
      id: value.revision.id,
      revision: value.revision.revision,
      schemaVersion: value.revision.schemaVersion,
      configurationFingerprint: value.revision.configurationFingerprint,
      configuration: value.revision.configuration,
      assets: {
        intro: mapAsset(value.revision.assets.intro),
        outro: mapAsset(value.revision.assets.outro),
        advertisement: mapAsset(value.revision.assets.advertisement),
        banners: value.revision.assets.banners.map((asset) => mapAsset(asset)!),
      },
      createdAt: value.revision.createdAt.toISOString(),
    },
    validation: value.validation,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}
