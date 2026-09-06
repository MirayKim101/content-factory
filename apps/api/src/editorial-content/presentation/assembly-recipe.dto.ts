import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import {
  ASSEMBLY_AUDIO_PROFILE,
  ASSEMBLY_ENCODING_PROFILE,
  ASSEMBLY_POSITIONS,
  ASSEMBLY_SCHEMA_VERSION,
  type AssemblyPosition,
} from "../domain/assembly-recipe.js";

export class AssemblyAdvertisementDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  assetId!: string;

  @ApiProperty({ type: "integer", format: "int32", minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  insertAtMs!: number;
}

export class AssemblyBannerDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  @IsString()
  @Length(1, 100)
  clientItemId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  assetId!: string;

  @ApiProperty({ type: "integer", format: "int32", minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  startMs!: number;

  @ApiProperty({ type: "integer", format: "int32", minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  endMs!: number;

  @ApiProperty({ enum: ASSEMBLY_POSITIONS })
  @IsIn(ASSEMBLY_POSITIONS)
  position!: AssemblyPosition;
}

export class AssemblyCtaDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  text!: string;

  @ApiProperty({ type: "integer", format: "int32", minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  startMs!: number;

  @ApiProperty({ type: "integer", format: "int32", minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  endMs!: number;

  @ApiProperty({ enum: ASSEMBLY_POSITIONS })
  @IsIn(ASSEMBLY_POSITIONS)
  position!: AssemblyPosition;
}

export class SaveAssemblyRecipeDto {
  @ApiProperty({ type: "integer", format: "int32", minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(2_147_483_646)
  expectedRevision!: number;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  @IsOptional()
  @IsUUID("4")
  introAssetId?: string | null;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  @IsOptional()
  @IsUUID("4")
  outroAssetId?: string | null;

  @ApiPropertyOptional({ type: AssemblyAdvertisementDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssemblyAdvertisementDto)
  advertisement?: AssemblyAdvertisementDto | null;

  @ApiProperty({ type: [AssemblyBannerDto], maxItems: 8 })
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => AssemblyBannerDto)
  banners!: AssemblyBannerDto[];

  @ApiPropertyOptional({ type: AssemblyCtaDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssemblyCtaDto)
  cta?: AssemblyCtaDto | null;

  @ApiProperty({ enum: [ASSEMBLY_AUDIO_PROFILE] })
  @IsIn([ASSEMBLY_AUDIO_PROFILE])
  audioProfileVersion!: typeof ASSEMBLY_AUDIO_PROFILE;

  @ApiProperty({ enum: [ASSEMBLY_ENCODING_PROFILE] })
  @IsIn([ASSEMBLY_ENCODING_PROFILE])
  encodingProfileVersion!: typeof ASSEMBLY_ENCODING_PROFILE;
}

export class AssemblyRecipeListQueryDto {
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

export class AssemblyAssetSnapshotResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) revision!: number;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) sizeBytes!: string;
  @ApiProperty({ enum: ["ADVERTISEMENT", "INTRO", "OUTRO", "BANNER"] })
  kind!: string;
  @ApiProperty({ type: "integer", nullable: true })
  durationMs!: number | null;
}

export class AssemblyAssetSnapshotsResponseDto {
  @ApiProperty({ type: AssemblyAssetSnapshotResponseDto, nullable: true })
  intro!: AssemblyAssetSnapshotResponseDto | null;
  @ApiProperty({ type: AssemblyAssetSnapshotResponseDto, nullable: true })
  outro!: AssemblyAssetSnapshotResponseDto | null;
  @ApiProperty({ type: AssemblyAssetSnapshotResponseDto, nullable: true })
  advertisement!: AssemblyAssetSnapshotResponseDto | null;
  @ApiProperty({ type: [AssemblyAssetSnapshotResponseDto] })
  banners!: AssemblyAssetSnapshotResponseDto[];
}

export class AssemblyConfigurationResponseDto {
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  introAssetId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  outroAssetId!: string | null;
  @ApiProperty({ type: AssemblyAdvertisementDto, nullable: true })
  advertisement!: AssemblyAdvertisementDto | null;
  @ApiProperty({ type: [AssemblyBannerDto] }) banners!: AssemblyBannerDto[];
  @ApiProperty({ type: AssemblyCtaDto, nullable: true })
  cta!: AssemblyCtaDto | null;
  @ApiProperty({ enum: [ASSEMBLY_AUDIO_PROFILE] })
  audioProfileVersion!: string;
  @ApiProperty({ enum: [ASSEMBLY_ENCODING_PROFILE] })
  encodingProfileVersion!: string;
}

export class AssemblyCutSnapshotResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) sizeBytes!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) sourceVersion!: number;
  @ApiProperty({ type: String }) recipeVersion!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) durationMs!: number;
}

export class AssemblyRecipeRevisionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) revision!: number;
  @ApiProperty({ enum: [ASSEMBLY_SCHEMA_VERSION] }) schemaVersion!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  configurationFingerprint!: string;
  @ApiProperty({ type: AssemblyConfigurationResponseDto })
  configuration!: AssemblyConfigurationResponseDto;
  @ApiProperty({ type: AssemblyAssetSnapshotsResponseDto })
  assets!: AssemblyAssetSnapshotsResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class AssemblyRecipeValidationResponseDto {
  @ApiProperty({ type: Boolean, enum: [true] }) valid!: true;
}

export class AssemblyRecipeResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) pipelineJobId!: string;
  @ApiProperty({ type: AssemblyCutSnapshotResponseDto })
  cutResultArtifact!: AssemblyCutSnapshotResponseDto;
  @ApiProperty({ type: AssemblyRecipeRevisionResponseDto })
  revision!: AssemblyRecipeRevisionResponseDto;
  @ApiProperty({ type: AssemblyRecipeValidationResponseDto })
  validation!: AssemblyRecipeValidationResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class AssemblyRecipeListResponseDto {
  @ApiProperty({ type: [AssemblyRecipeResponseDto] })
  items!: AssemblyRecipeResponseDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  nextCursor!: string | null;
}
