import type {
  AuthorizationDetail,
  CreatorProfileDetail,
  CreatorProfileRevisionView,
  CreatorProfileSummary,
  CreatorReferenceAssetView,
  CutPromptDetail,
  CutPromptRevisionView,
  SourceContextDetail,
  SourceContextRevisionView,
} from "../application/creator-context-repository.port.js";
import type {
  AuthorizationDetailResponseDto,
  CreatorProfileDetailResponseDto,
  CreatorProfileRevisionResponseDto,
  CreatorProfileSummaryResponseDto,
  CreatorReferenceAssetResponseDto,
  CreatorReferenceAuthorizationResponseDto,
  CutEditorialPromptDetailResponseDto,
  CutEditorialPromptRevisionResponseDto,
  SourceEditorialContextDetailResponseDto,
  SourceEditorialContextRevisionResponseDto,
} from "./creator-context.dto.js";

export function profileDetailResponse(
  value: CreatorProfileDetail,
): CreatorProfileDetailResponseDto {
  return {
    id: value.id,
    currentRevision: value.currentRevision,
    revision: profileRevisionResponse(value.revision),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export function profileRevisionResponse(
  value: CreatorProfileRevisionView,
): CreatorProfileRevisionResponseDto {
  return {
    ...value,
    defaultReference: value.defaultReference
      ? {
          ...value.defaultReference,
          expiresAt: value.defaultReference.expiresAt?.toISOString() ?? null,
        }
      : null,
    createdAt: value.createdAt.toISOString(),
  };
}

export function profileSummaryResponse(
  value: CreatorProfileSummary,
): CreatorProfileSummaryResponseDto {
  return { ...value, updatedAt: value.updatedAt.toISOString() };
}

function authorizationResponse(
  value: CreatorReferenceAssetView["currentAuthorization"],
): CreatorReferenceAuthorizationResponseDto {
  return {
    ...value,
    expiresAt: value.expiresAt?.toISOString() ?? null,
    decidedAt: value.decidedAt?.toISOString() ?? null,
    createdAt: value.createdAt.toISOString(),
  };
}

export function referenceAssetResponse(
  value: CreatorReferenceAssetView,
): CreatorReferenceAssetResponseDto {
  return {
    ...value,
    sizeBytes: value.sizeBytes.toString(),
    currentAuthorization: authorizationResponse(value.currentAuthorization),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export function authorizationDetailResponse(
  value: AuthorizationDetail,
): AuthorizationDetailResponseDto {
  return {
    ...value,
    current: authorizationResponse(value.current),
    history: value.history.map(authorizationResponse),
  };
}

export function sourceContextDetailResponse(
  value: SourceContextDetail,
): SourceEditorialContextDetailResponseDto {
  return {
    id: value.id,
    currentRevision: value.currentRevision,
    revision: sourceContextRevisionResponse(value.revision),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export function sourceContextRevisionResponse(
  value: SourceContextRevisionView,
): SourceEditorialContextRevisionResponseDto {
  return { ...value, createdAt: value.createdAt.toISOString() };
}

export function cutPromptDetailResponse(
  value: CutPromptDetail,
): CutEditorialPromptDetailResponseDto {
  return {
    id: value.id,
    currentRevision: value.currentRevision,
    revision: cutPromptRevisionResponse(value.revision),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export function cutPromptRevisionResponse(
  value: CutPromptRevisionView,
): CutEditorialPromptRevisionResponseDto {
  return {
    ...value,
    cutResultArtifact: {
      ...value.cutResultArtifact,
      sizeBytes: value.cutResultArtifact.sizeBytes.toString(),
    },
    createdAt: value.createdAt.toISOString(),
  };
}
