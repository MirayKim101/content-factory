import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Allow,
  Equals,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Matches,
} from "class-validator";

export class CreateProjectUploadDto {
  @ApiProperty({
    type: String,
    example: "First source",
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  name!: string;

  @ApiPropertyOptional({
    type: String,
    enum: ["true"],
    deprecated: true,
    description:
      "Legacy factual upload attestation. It never clears source authorization.",
  })
  @IsOptional()
  @Equals("true")
  rightsConfirmed?: string;

  @ApiProperty({ type: "string", format: "binary" })
  @Allow()
  file!: unknown;
}

class RightsResponseDto {
  @ApiProperty({ type: String, format: "date-time" })
  confirmedAt!: string;

  @ApiProperty({ type: String, example: "upload-rights-v1" })
  declarationVersion!: string;
}

class AuthorizationResponseDto {
  @ApiProperty({ type: String, enum: ["NOT_REVIEWED", "CLEARED"] })
  status!: string;

  @ApiProperty({ type: Number, example: 1 })
  sourceVersion!: number;

  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  sourceSha256!: string;

  @ApiProperty({
    type: String,
    enum: ["EXPLICIT_CONFIRMATION", "LEGACY_ATTESTATION"],
    nullable: true,
  })
  basis!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  confirmedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  declarationVersion!: string | null;
}

export class ConfirmSourceAuthorizationDto {
  @ApiProperty({ type: Number, example: 1 })
  @IsInt()
  @IsPositive()
  sourceVersion!: number;

  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  sourceSha256!: string;

  @ApiProperty({ type: Boolean, enum: [true] })
  @Equals(true)
  rightsConfirmed!: boolean;

  @ApiProperty({ type: String, example: "source-rights-v1" })
  @IsString()
  @Length(1, 100)
  declarationVersion!: string;
}

class FailureResponseDto {
  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  message!: string;
}

class SourceResponseDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({
    type: String,
    enum: ["PENDING", "READY", "FAILED_FINAL"],
  })
  status!: string;

  @ApiProperty({ type: Number, example: 1 })
  sourceVersion!: number;

  @ApiProperty({ type: String })
  originalFilename!: string;

  @ApiProperty({ type: String, example: "video/mp4" })
  contentType!: string;

  @ApiProperty({
    type: String,
    example: "123456",
    description: "Decimal string for bigint safety.",
  })
  sizeBytes!: string;

  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  sha256!: string;
}

class ArtifactResponseDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, enum: ["SOURCE"] })
  role!: string;

  @ApiProperty({
    type: String,
    enum: ["PENDING", "READY", "FAILED_FINAL"],
  })
  status!: string;

  @ApiProperty({
    type: String,
    example: "123456",
    description: "Decimal string for bigint safety.",
  })
  sizeBytes!: string;

  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  sha256!: string;

  @ApiProperty({ type: String, example: "video/mp4" })
  contentType!: string;

  @ApiProperty({ type: String, format: "uuid" })
  lineageSourceId!: string;

  @ApiProperty({ type: Number, example: 1 })
  lineageSourceVersion!: number;

  @ApiProperty({ type: String, example: "source-ingest-v1" })
  recipeVersion!: string;
}

export class ProjectResponseDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({
    type: String,
    enum: ["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"],
  })
  status!: string;

  @ApiProperty({ type: () => RightsResponseDto, nullable: true })
  rights!: RightsResponseDto | null;

  @ApiProperty({ type: () => AuthorizationResponseDto })
  authorization!: AuthorizationResponseDto;

  @ApiPropertyOptional({ type: () => FailureResponseDto })
  failure?: FailureResponseDto;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: string;

  @ApiProperty({ type: () => SourceResponseDto })
  source!: SourceResponseDto;

  @ApiProperty({ type: () => ArtifactResponseDto })
  artifact!: ArtifactResponseDto;
}

class ErrorDetailDto {
  @ApiProperty({
    type: String,
    enum: [
      "VALIDATION_FAILED",
      "IDEMPOTENCY_KEY_INVALID",
      "FILE_REQUIRED",
      "INVALID_MULTIPART",
      "IDEMPOTENCY_CONFLICT",
      "UPLOAD_TOO_LARGE",
      "INVALID_MP4",
      "PROJECT_NOT_FOUND",
      "INTERNAL_ERROR",
      "DATABASE_FINALIZE_FAILED",
      "STORAGE_UPLOAD_FAILED",
      "SOURCE_NOT_READY",
      "SOURCE_VERSION_MISMATCH",
      "RIGHTS_DECLARATION_OUTDATED",
      "SOURCE_AUTHORIZATION_CONFLICT",
      "SOURCE_NOT_AUTHORIZED",
    ],
  })
  code!: string;

  @ApiProperty({ type: String })
  message!: string;
}

export class ErrorResponseDto {
  @ApiProperty({ type: () => ErrorDetailDto })
  error!: ErrorDetailDto;
}
