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
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateEditorialApprovalDto {
  @ApiProperty({ type: "integer", minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  editorialRevision!: number;

  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  candidateFingerprint!: string;

  @ApiProperty({ type: "integer", minimum: 0, maximum: 28_800_000 })
  @IsInt()
  @Min(0)
  @Max(28_800_000)
  manualAttentionMs!: number;

  @ApiProperty({ enum: ["foreground-preview-v1"] })
  @IsIn(["foreground-preview-v1"])
  attentionMeasurementVersion!: "foreground-preview-v1";
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
  @ApiProperty({ enum: ["foreground-preview-v1"] })
  attentionMeasurementVersion!: string;
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
  @ApiProperty({ enum: ["manual-horizontal-approval-v1"] })
  approvalContractVersion!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  candidateFingerprint!: string;
  @ApiProperty({ type: String, format: "date-time" }) approvedAt!: string;
  @ApiProperty({ enum: ["CURRENT", "STALE"] }) state!: string;
  @ApiProperty({ type: [String] }) staleReasons!: string[];
  @ApiProperty({ type: EditorialApprovalMetricsResponseDto })
  metrics!: EditorialApprovalMetricsResponseDto;
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
  @ApiProperty({ type: EditorialApprovalResponseDto, nullable: true })
  currentApproval!: EditorialApprovalResponseDto | null;
  @ApiProperty({ type: EditorialApprovalResponseDto, nullable: true })
  latestApproval!: EditorialApprovalResponseDto | null;
}
