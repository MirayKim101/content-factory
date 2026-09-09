import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Max,
  Min,
} from "class-validator";

export class CreateProcessingTemplateDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  name!: string;
}

export class ProcessingTemplateRevisionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) templateId!: string;
  @ApiProperty({ type: "integer", format: "int32", minimum: 1 })
  revision!: number;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, enum: ["manual-editorial-v1"] })
  configurationVersion!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class ProcessingTemplateListResponseDto {
  @ApiProperty({ type: [ProcessingTemplateRevisionResponseDto] })
  items!: ProcessingTemplateRevisionResponseDto[];
}

export class ThumbnailUploadDto {
  @ApiProperty({ type: "string", format: "binary" })
  @Allow()
  file!: unknown;
}

class EditorialFailureResponseDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class EditorialAssetResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, enum: ["THUMBNAIL"] }) type!: string;
  @ApiProperty({
    type: String,
    enum: ["PENDING", "READY", "FAILED_FINAL"],
  })
  status!: string;
  @ApiProperty({ type: String }) originalFilename!: string;
  @ApiProperty({
    type: String,
    enum: ["image/jpeg", "image/png", "image/webp"],
  })
  contentType!: string;
  @ApiProperty({
    type: String,
    pattern: "^\\d+$",
    description: "Decimal string for bigint safety.",
  })
  sizeBytes!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({
    type: "integer",
    format: "int32",
    minimum: 1,
    maximum: 40_000_000,
  })
  width!: number;
  @ApiProperty({
    type: "integer",
    format: "int32",
    minimum: 1,
    maximum: 40_000_000,
  })
  height!: number;
  @ApiPropertyOptional({ type: EditorialFailureResponseDto })
  failure?: EditorialFailureResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class EditorialAssetListResponseDto {
  @ApiProperty({ type: [EditorialAssetResponseDto] })
  items!: EditorialAssetResponseDto[];
}

export class SaveEditorialPackageDto {
  @ApiProperty({
    type: "integer",
    format: "int32",
    minimum: 0,
    maximum: 2_147_483_646,
  })
  @IsInt()
  @Min(0)
  @Max(2_147_483_646)
  expectedRevision!: number;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  processingTemplateRevisionId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional({
    type: "array",
    items: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "\\S",
    },
    nullable: true,
    minItems: 0,
    maxItems: 30,
    description: "Ordered tags. Order is preserved exactly.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  @Matches(/\S/, { each: true })
  tags?: string[] | null;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  @IsOptional()
  @IsUUID("4")
  thumbnailAssetId?: string | null;
}

class CutResultArtifactResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) sizeBytes!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: "integer", format: "int32", minimum: 1 })
  sourceVersion!: number;
  @ApiProperty({ type: String }) recipeVersion!: string;
}

class EditorialRevisionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer", format: "int32", minimum: 1 })
  revision!: number;
  @ApiProperty({ type: ProcessingTemplateRevisionResponseDto })
  processingTemplateRevision!: ProcessingTemplateRevisionResponseDto;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: [String], nullable: true }) tags!: string[] | null;
  @ApiProperty({ type: EditorialAssetResponseDto, nullable: true })
  thumbnail!: EditorialAssetResponseDto | null;
  @ApiProperty({
    type: "object",
    properties: {
      metadata: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["MANUAL", "AI_ASSISTED", "MIXED"] },
          basisVersion: { type: "string" },
        },
        required: ["mode", "basisVersion"],
      },
      thumbnail: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["MANUAL", "AI_ASSISTED", "MIXED"] },
          basisVersion: { type: "string" },
        },
        required: ["mode", "basisVersion"],
      },
    },
    required: ["metadata", "thumbnail"],
  })
  provenance!: {
    metadata: { mode: string; basisVersion: string };
    thumbnail: { mode: string; basisVersion: string };
  };
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

class EditorialValidationResponseDto {
  @ApiProperty({ type: Boolean }) complete!: boolean;
  @ApiProperty({
    type: [String],
    enum: ["TITLE", "DESCRIPTION", "TAGS", "THUMBNAIL"],
  })
  missingFields!: string[];
}

export class EditorialPackageResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) pipelineJobId!: string;
  @ApiProperty({ type: CutResultArtifactResponseDto })
  cutResultArtifact!: CutResultArtifactResponseDto;
  @ApiProperty({ type: EditorialRevisionResponseDto })
  revision!: EditorialRevisionResponseDto;
  @ApiProperty({ type: EditorialValidationResponseDto })
  validation!: EditorialValidationResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class EditorialPackageListResponseDto {
  @ApiProperty({ type: [EditorialPackageResponseDto] })
  items!: EditorialPackageResponseDto[];
}
