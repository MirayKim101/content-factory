import type {
  ApprovalProcessingMetrics,
  EditorialApprovalView,
  EditorialReviewView,
} from "../domain/editorial-approval.js";
import type {
  ApprovalProcessingMetricsResponseDto,
  EditorialApprovalResponseDto,
  EditorialReviewResponseDto,
} from "./editorial-approval.dto.js";

export function editorialApprovalResponse(
  value: EditorialApprovalView,
): EditorialApprovalResponseDto {
  return {
    ...value,
    thumbnailSizeBytes: value.thumbnailSizeBytes.toString(),
    renderArtifactSizeBytes: value.renderArtifactSizeBytes.toString(),
    approvedAt: value.approvedAt.toISOString(),
    metrics: {
      ...processingMetricsResponse(value.metrics),
      manualAttentionMs: value.metrics.manualAttentionMs,
      attentionMeasurementVersion: value.metrics.attentionMeasurementVersion,
    },
  };
}

export function editorialReviewResponse(
  value: EditorialReviewView,
): EditorialReviewResponseDto {
  return {
    ...value,
    editorial: value.editorial
      ? {
          ...value.editorial,
          thumbnail: {
            ...value.editorial.thumbnail,
            sizeBytes: value.editorial.thumbnail.sizeBytes.toString(),
          },
        }
      : null,
    render: value.render
      ? {
          ...value.render,
          artifactSizeBytes: value.render.artifactSizeBytes.toString(),
        }
      : null,
    processingMetrics: value.processingMetrics
      ? processingMetricsResponse(value.processingMetrics)
      : null,
    currentApproval: value.currentApproval
      ? editorialApprovalResponse(value.currentApproval)
      : null,
    latestApproval: value.latestApproval
      ? editorialApprovalResponse(value.latestApproval)
      : null,
  };
}

function processingMetricsResponse(
  value: ApprovalProcessingMetrics,
): ApprovalProcessingMetricsResponseDto {
  return { ...value, outputBytes: value.outputBytes.toString() };
}
