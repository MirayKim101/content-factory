import type {
  EditorialAssetView,
  EditorialPackageView,
  ProcessingTemplateRevisionView,
} from "../domain/editorial.js";
import type {
  EditorialAssetResponseDto,
  EditorialPackageResponseDto,
  ProcessingTemplateRevisionResponseDto,
} from "./editorial.dto.js";

export function toProcessingTemplateResponse(
  value: ProcessingTemplateRevisionView,
): ProcessingTemplateRevisionResponseDto {
  return { ...value, createdAt: value.createdAt.toISOString() };
}

export function toEditorialAssetResponse(
  value: EditorialAssetView,
): EditorialAssetResponseDto {
  return {
    ...value,
    sizeBytes: value.sizeBytes.toString(),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export function toEditorialPackageResponse(
  value: EditorialPackageView,
): EditorialPackageResponseDto {
  return {
    id: value.id,
    projectId: value.projectId,
    pipelineJobId: value.pipelineJobId,
    cutResultArtifact: {
      ...value.cutResultArtifact,
      sizeBytes: value.cutResultArtifact.sizeBytes.toString(),
    },
    revision: {
      ...value.revision,
      processingTemplateRevision: toProcessingTemplateResponse(
        value.revision.processingTemplateRevision,
      ),
      thumbnail: value.revision.thumbnail
        ? toEditorialAssetResponse(value.revision.thumbnail)
        : null,
      createdAt: value.revision.createdAt.toISOString(),
    },
    validation: value.validation,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}
