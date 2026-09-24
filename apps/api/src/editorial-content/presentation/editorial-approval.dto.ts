import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class OperatorAttentionV2Dto {
  @ApiProperty({ enum: ["operator-attention-v2"] })
  @IsIn(["operator-attention-v2"])
  schemaVersion!: "operator-attention-v2";

  @ApiProperty({ type: "integer", minimum: 0, maximum: 28_800_000 })
  @IsInt()
  @Min(0)
  @Max(28_800_000)
  preparationForegroundMs!: number;

  @ApiProperty({ type: "integer", minimum: 0, maximum: 28_800_000 })
  @IsInt()
  @Min(0)
  @Max(28_800_000)
  finalReviewForegroundMs!: number;
}

export class CreateEditorialApprovalDto {
  @ApiPropertyOptional({
    enum: ["manual-horizontal-approval-v1", "human-horizontal-approval-v2"],
  })
  @IsOptional()
  @IsIn(["manual-horizontal-approval-v1", "human-horizontal-approval-v2"])
  approvalContractVersion?:
    "manual-horizontal-approval-v1" | "human-horizontal-approval-v2";

  @ApiProperty({ type: "integer", minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  editorialRevision!: number;

  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  candidateFingerprint!: string;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 28_800_000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(28_800_000)
  manualAttentionMs?: number;

  @ApiPropertyOptional({ enum: ["foreground-preview-v1"] })
  @IsOptional()
  @IsIn(["foreground-preview-v1"])
  attentionMeasurementVersion?: "foreground-preview-v1";

  @ApiPropertyOptional({ type: () => OperatorAttentionV2Dto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OperatorAttentionV2Dto)
  attention?: OperatorAttentionV2Dto;
}

export class EditorialApprovalListQueryDto {
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  cursor?: string;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class ApprovalJobMetricsResponseDto {
  @ApiProperty({ type: "integer", nullable: true })
  initialQueueWaitMs!: number | null;
  @ApiProperty({ type: "integer", nullable: true }) retryWaitMs!: number | null;
  @ApiProperty({ type: "integer", nullable: true })
  firstStartToFinishMs!: number | null;
  @ApiProperty({ type: "integer", nullable: true }) activeAttemptMs!:
    number | null;
  @ApiProperty({ type: "integer", minimum: 0 }) attemptCount!: number;
  @ApiProperty({ type: "integer", minimum: 0 }) retryCount!: number;
}

export class ApprovalProcessingMetricsResponseDto {
  @ApiProperty({ enum: ["approval-metrics-v1"] })
  metricsSchemaVersion!: string;
  @ApiProperty({ enum: ["persisted-job-attempt-v1"] })
  timestampBasisVersion!: string;
  @ApiProperty({ type: ApprovalJobMetricsResponseDto })
  cut!: ApprovalJobMetricsResponseDto;
  @ApiProperty({ type: ApprovalJobMetricsResponseDto })
  assembly!: ApprovalJobMetricsResponseDto;
  @ApiProperty({ type: "integer", nullable: true })
  cutToAssemblyReadyElapsedMs!: number | null;
  @ApiProperty({ type: "integer", minimum: 1 }) outputDurationMs!: number;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) outputBytes!: string;
  @ApiProperty({ type: "integer", enum: [0] }) directProviderCostMinor!: number;
  @ApiProperty({ enum: ["RUB"] }) costCurrency!: string;
  @ApiProperty({ enum: ["local-direct-provider-cost-v1"] })
  costBasisVersion!: string;
  @ApiProperty({ type: [String] }) incompleteReasons!: string[];
}

export class EditorialApprovalMetricsResponseDto extends ApprovalProcessingMetricsResponseDto {
  @ApiProperty({ type: "integer", minimum: 0, maximum: 28_800_000 })
  manualAttentionMs!: number;
  @ApiProperty({ enum: ["foreground-preview-v1", "operator-attention-v2"] })
  attentionMeasurementVersion!: string;
}

export class EditorialCitationResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uri" }) url!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) publisher!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  publishedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) accessedAt!: string;
}

export class EditorialResearchFreshnessResponseDto {
  @ApiProperty({ type: String, format: "date-time" }) searchedAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) freshUntil!: string;
  @ApiProperty({ enum: ["CURRENT", "EXPIRED"] }) freshness!: string;
}

export class EditorialImageSafetyDecisionResponseDto {
  @ApiProperty({ type: String, enum: ["no-likeness-safety-v1"] })
  version!: "no-likeness-safety-v1";
  @ApiProperty({ type: Boolean, enum: [false] })
  realisticPersonRequested!: false;
  @ApiProperty({ type: Boolean, enum: [false] }) referenceImageUsed!: false;
  @ApiProperty({ type: Boolean, enum: [false] }) externalProviderUsed!: false;
}

export class EditorialComponentSummaryResponseDto {
  @ApiProperty({ enum: ["METADATA", "THUMBNAIL"] }) component!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  provenanceId!: string | null;
  @ApiProperty({ enum: ["MANUAL", "AI_ASSISTED", "MIXED"] }) mode!: string;
  @ApiProperty({ type: String }) basisVersion!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  researchIntentId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  suggestionSetId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  imageIntentId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  imageCandidateId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  transcriptArtifactId!: string | null;
  @ApiProperty({ type: String, nullable: true }) transcriptSha256!:
    string | null;
  @ApiProperty({ type: [EditorialCitationResponseDto] })
  citations!: EditorialCitationResponseDto[];
  @ApiProperty({ type: EditorialResearchFreshnessResponseDto, nullable: true })
  research!: EditorialResearchFreshnessResponseDto | null;
  @ApiProperty({
    type: EditorialImageSafetyDecisionResponseDto,
    additionalProperties: false,
    nullable: true,
  })
  imageSafetyDecision!: EditorialImageSafetyDecisionResponseDto | null;
  @ApiProperty({ type: String, nullable: true }) likeness!: string | null;
  @ApiProperty({ type: String, pattern: "^\\d+$" })
  directCostMicrousd!: string;
  @ApiProperty({ type: String }) costBasisVersion!: string;
  @ApiProperty({ type: [String] }) incompleteReasons!: string[];
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  snapshotFingerprint!: string;
}

export class EditorialEconomicsPreviewResponseDto {
  @ApiProperty({ type: ApprovalProcessingMetricsResponseDto, nullable: true })
  processingMetrics!: ApprovalProcessingMetricsResponseDto | null;
  @ApiProperty({ type: String, pattern: "^\\d+$" })
  metadataDirectCostMicrousd!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" })
  evidenceDirectCostMicrousd!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" })
  thumbnailDirectCostMicrousd!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" })
  combinedDirectCostMicrousd!: string;
  @ApiProperty({ enum: ["USD"] }) currency!: string;
  @ApiProperty({ enum: ["MICRO"] }) unit!: string;
  @ApiProperty({ type: [String] }) incompleteReasons!: string[];
}

export class EditorialReviewComponentsResponseDto {
  @ApiProperty({ type: EditorialComponentSummaryResponseDto })
  metadata!: EditorialComponentSummaryResponseDto;
  @ApiProperty({ type: EditorialComponentSummaryResponseDto })
  thumbnail!: EditorialComponentSummaryResponseDto;
}

export class EditorialApprovalResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) sourceVersion!: number;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, format: "uuid" }) editorialPackageId!: string;
  @ApiProperty({ type: String, format: "uuid" })
  editorialPackageRevisionId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) editorialRevision!: number;
  @ApiProperty({ type: String, format: "uuid" })
  processingTemplateRevisionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) thumbnailAssetId!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  thumbnailSha256!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" })
  thumbnailSizeBytes!: string;
  @ApiProperty({ enum: ["image/jpeg", "image/png", "image/webp"] })
  thumbnailContentType!: string;
  @ApiProperty({ type: String, format: "uuid" }) assemblyRecipeId!: string;
  @ApiProperty({ type: String, format: "uuid" }) recipeRevisionId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) recipeRevision!: number;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  configurationFingerprint!: string;
  @ApiProperty({ type: String, format: "uuid" })
  assemblyRenderIntentId!: string;
  @ApiProperty({ type: String, format: "uuid" })
  assemblyRenderResultId!: string;
  @ApiProperty({ type: String, format: "uuid" }) renderArtifactId!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  renderArtifactSha256!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" })
  renderArtifactSizeBytes!: string;
  @ApiProperty({ enum: ["horizontal-render-v1"] })
  renderContractVersion!: string;
  @ApiProperty({
    enum: ["manual-horizontal-approval-v1", "human-horizontal-approval-v2"],
  })
  approvalContractVersion!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  candidateFingerprint!: string;
  @ApiProperty({ type: String, format: "date-time" }) approvedAt!: string;
  @ApiProperty({ enum: ["CURRENT", "STALE"] }) state!: string;
  @ApiProperty({ type: [String] }) staleReasons!: string[];
  @ApiProperty({ type: EditorialApprovalMetricsResponseDto })
  metrics!: EditorialApprovalMetricsResponseDto;
  @ApiProperty({ type: [EditorialComponentSummaryResponseDto] })
  componentSnapshots!: EditorialComponentSummaryResponseDto[];
  @ApiProperty({ type: "object", additionalProperties: true, nullable: true })
  economicsV2!: Record<string, unknown> | null;
}

export class EditorialApprovalListResponseDto {
  @ApiProperty({ type: [EditorialApprovalResponseDto] })
  items!: EditorialApprovalResponseDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  nextCursor!: string | null;
}

export class EditorialReviewThumbnailResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) sizeBytes!: string;
  @ApiProperty({ enum: ["image/jpeg", "image/png", "image/webp"] })
  contentType!: string;
  @ApiProperty({ type: String }) filename!: string;
  @ApiProperty({ type: String, format: "uri-reference" }) contentUrl!: string;
}

export class EditorialReviewEditorialResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) packageId!: string;
  @ApiProperty({ type: String, format: "uuid" }) revisionId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) revision!: number;
  @ApiProperty({ type: String, format: "uuid" })
  processingTemplateRevisionId!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) description!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ type: EditorialReviewThumbnailResponseDto })
  thumbnail!: EditorialReviewThumbnailResponseDto;
}

export class EditorialReviewRecipeResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) revisionId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) revision!: number;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  configurationFingerprint!: string;
}

export class EditorialReviewRenderResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) resultId!: string;
  @ApiProperty({ type: String, format: "uuid" }) artifactId!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  artifactSha256!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) artifactSizeBytes!: string;
  @ApiProperty({ enum: ["horizontal-render-v1"] })
  renderContractVersion!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) durationMs!: number;
  @ApiProperty({ type: String, format: "uri-reference" }) contentUrl!: string;
}

export class EditorialReviewResponseDto {
  @ApiProperty({ enum: ["editorial-review-candidate-v2"] })
  reviewContractVersion!: string;
  @ApiProperty({ type: Boolean }) integratedReviewEnabled!: boolean;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) sourceVersion!: number;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  cutResultArtifactId!: string | null;
  @ApiProperty({ type: EditorialReviewEditorialResponseDto, nullable: true })
  editorial!: EditorialReviewEditorialResponseDto | null;
  @ApiProperty({ type: EditorialReviewRecipeResponseDto, nullable: true })
  recipe!: EditorialReviewRecipeResponseDto | null;
  @ApiProperty({ type: EditorialReviewRenderResponseDto, nullable: true })
  render!: EditorialReviewRenderResponseDto | null;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$", nullable: true })
  candidateFingerprint!: string | null;
  @ApiProperty({ type: Boolean }) approvable!: boolean;
  @ApiProperty({ type: [String] }) blockers!: string[];
  @ApiProperty({ type: ApprovalProcessingMetricsResponseDto, nullable: true })
  processingMetrics!: ApprovalProcessingMetricsResponseDto | null;
  @ApiProperty({ enum: ["MANUAL", "AI_ASSISTED", "MIXED"] })
  workflowMode!: string;
  @ApiProperty({ type: EditorialReviewComponentsResponseDto })
  components!: {
    metadata: EditorialComponentSummaryResponseDto;
    thumbnail: EditorialComponentSummaryResponseDto;
  };
  @ApiProperty({ type: EditorialEconomicsPreviewResponseDto })
  economicsPreview!: EditorialEconomicsPreviewResponseDto;
  @ApiProperty({ type: EditorialApprovalResponseDto, nullable: true })
  currentApproval!: EditorialApprovalResponseDto | null;
  @ApiProperty({ type: EditorialApprovalResponseDto, nullable: true })
  latestApproval!: EditorialApprovalResponseDto | null;
}
