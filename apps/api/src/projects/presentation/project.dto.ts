import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow, Equals, IsString, Length, Matches } from "class-validator";

export class CreateProjectUploadDto {
  @ApiProperty({ example: "First source" })
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  name!: string;

  @ApiProperty({ enum: ["true"], description: "Must be literal true." })
  @Equals("true")
  rightsConfirmed!: string;

  @ApiProperty({ type: "string", format: "binary" })
  @Allow()
  file!: unknown;
}

class RightsResponseDto {
  @ApiProperty({ format: "date-time" })
  confirmedAt!: string;

  @ApiProperty({ example: "upload-rights-v1" })
  declarationVersion!: string;
}

class FailureResponseDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;
}

class SourceResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: ["PENDING", "READY", "FAILED_FINAL"] })
  status!: string;

  @ApiProperty({ example: 1 })
  sourceVersion!: number;

  @ApiProperty()
  originalFilename!: string;

  @ApiProperty({ example: "video/mp4" })
  contentType!: string;

  @ApiProperty({
    example: "123456",
    description: "Decimal string for bigint safety.",
  })
  sizeBytes!: string;

  @ApiProperty({ pattern: "^[a-f0-9]{64}$" })
  sha256!: string;
}

class ArtifactResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: ["SOURCE"] })
  role!: string;

  @ApiProperty({ enum: ["PENDING", "READY", "FAILED_FINAL"] })
  status!: string;

  @ApiProperty({
    example: "123456",
    description: "Decimal string for bigint safety.",
  })
  sizeBytes!: string;

  @ApiProperty({ pattern: "^[a-f0-9]{64}$" })
  sha256!: string;

  @ApiProperty({ example: "video/mp4" })
  contentType!: string;

  @ApiProperty({ format: "uuid" })
  lineageSourceId!: string;

  @ApiProperty({ example: 1 })
  lineageSourceVersion!: number;

  @ApiProperty({ example: "source-ingest-v1" })
  recipeVersion!: string;
}

export class ProjectResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"] })
  status!: string;

  @ApiProperty({ type: RightsResponseDto })
  rights!: RightsResponseDto;

  @ApiPropertyOptional({ type: FailureResponseDto })
  failure?: FailureResponseDto;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;

  @ApiProperty({ type: SourceResponseDto })
  source!: SourceResponseDto;

  @ApiProperty({ type: ArtifactResponseDto })
  artifact!: ArtifactResponseDto;
}

class ErrorDetailDto {
  @ApiProperty({
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
    ],
  })
  code!: string;

  @ApiProperty()
  message!: string;
}

export class ErrorResponseDto {
  @ApiProperty({ type: ErrorDetailDto })
  error!: ErrorDetailDto;
}
