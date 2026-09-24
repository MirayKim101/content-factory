import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsUUID, Min } from "class-validator";

export class CreateImageSuggestionDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  sourceContextRevisionId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  cutPromptRevisionId!: string;
}

export class ApplyImageSuggestionDto {
  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedEditorialRevision!: number;
}

export class ImageSuggestionSafetyDecisionDto {
  @ApiProperty({ type: String, enum: ["no-likeness-safety-v1"] }) version!: string;
  @ApiProperty({ type: Boolean, enum: [false] }) realisticPersonRequested!: false;
  @ApiProperty({ type: Boolean, enum: [false] }) referenceImageUsed!: false;
  @ApiProperty({ type: Boolean, enum: [false] }) externalProviderUsed!: false;
}

export class ImageSuggestionFailureDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class ImageCandidateResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, enum: ["image/png"] }) contentType!: string;
  @ApiProperty({ type: String }) sizeBytes!: string;
  @ApiProperty({ type: String }) sha256!: string;
  @ApiProperty({ type: Number }) width!: number;
  @ApiProperty({ type: Number }) height!: number;
  @ApiProperty({ type: String, enum: ["NONE"] }) likeness!: string;
  @ApiProperty({
    type: ImageSuggestionSafetyDecisionDto,
    additionalProperties: false,
  })
  safetyDecision!: ImageSuggestionSafetyDecisionDto;
  @ApiProperty({ type: String }) directCostMicrousd!: string;
  @ApiProperty({ type: String }) costBasisVersion!: string;
}

export class ImageSuggestionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, enum: ["QUEUED", "PROCESSING", "READY", "FAILED_FINAL"] }) state!: string;
  @ApiProperty({ type: String }) contractVersion!: string;
  @ApiProperty({ type: String }) adapterVersion!: string;
  @ApiProperty({ type: String }) promptBasisVersion!: string;
  @ApiProperty({ type: ImageCandidateResponseDto, nullable: true }) candidate!: ImageCandidateResponseDto | null;
  @ApiProperty({ type: ImageSuggestionFailureDto, nullable: true }) failure!: ImageSuggestionFailureDto | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: Date;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: Date;
}

export class ImageSuggestionListResponseDto {
  @ApiProperty({ type: [ImageSuggestionResponseDto] }) items!: ImageSuggestionResponseDto[];
}

export class ImageSuggestionApplyResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) packageId!: string;
  @ApiProperty({ type: String, format: "uuid" }) packageRevisionId!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: String, format: "uuid" }) thumbnailAssetId!: string;
  @ApiProperty({ type: String, enum: ["AI_ASSISTED"] }) thumbnailMode!: string;
}
