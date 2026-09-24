import type {
  ApprovalProcessingMetrics,
  EditorialApprovalView,
  EditorialReviewView,
  EditorialReviewComponentSummary,
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
    componentSnapshots: value.componentSnapshots.map(componentResponse),
    economicsV2: value.economicsV2
      ? {
          ...value.economicsV2,
          metadataDirectCostMicrousd:
            value.economicsV2.metadataDirectCostMicrousd.toString(),
          evidenceDirectCostMicrousd:
            value.economicsV2.evidenceDirectCostMicrousd.toString(),
          thumbnailDirectCostMicrousd:
            value.economicsV2.thumbnailDirectCostMicrousd.toString(),
          combinedDirectCostMicrousd:
            value.economicsV2.combinedDirectCostMicrousd.toString(),
        }
      : null,
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
    components: {
      metadata: componentResponse(value.components.metadata),
      thumbnail: componentResponse(value.components.thumbnail),
    },
    economicsPreview: {
      ...value.economicsPreview,
      processingMetrics: value.economicsPreview.processingMetrics
        ? processingMetricsResponse(value.economicsPreview.processingMetrics)
        : null,
      metadataDirectCostMicrousd:
        value.economicsPreview.metadataDirectCostMicrousd.toString(),
      evidenceDirectCostMicrousd:
        value.economicsPreview.evidenceDirectCostMicrousd.toString(),
      thumbnailDirectCostMicrousd:
        value.economicsPreview.thumbnailDirectCostMicrousd.toString(),
      combinedDirectCostMicrousd:
        value.economicsPreview.combinedDirectCostMicrousd.toString(),
    },
    currentApproval: value.currentApproval
      ? editorialApprovalResponse(value.currentApproval)
      : null,
    latestApproval: value.latestApproval
      ? editorialApprovalResponse(value.latestApproval)
      : null,
  };
}

function componentResponse(value: EditorialReviewComponentSummary) {
  return {
    ...value,
    citations: value.citations.map((citation) => ({
      ...citation,
      publishedAt: citation.publishedAt?.toISOString() ?? null,
      accessedAt: citation.accessedAt.toISOString(),
    })),
    research: value.research
      ? {
          ...value.research,
          searchedAt: value.research.searchedAt.toISOString(),
          freshUntil: value.research.freshUntil.toISOString(),
        }
      : null,
    imageSafetyDecision: value.imageSafetyDecision,
    directCostMicrousd: value.directCostMicrousd.toString(),
  };
}

function processingMetricsResponse(
  value: ApprovalProcessingMetrics,
): ApprovalProcessingMetricsResponseDto {
  return { ...value, outputBytes: value.outputBytes.toString() };
}
