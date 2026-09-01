import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow, Equals, IsString, Length, Matches } from "class-validator";

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

  @ApiProperty({
    type: String,
    enum: ["true"],
    description: "Must be literal true.",
  })
  @Equals("true")
  rightsConfirmed!: string;

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

  @ApiProperty({ type: () => RightsResponseDto })
  rights!: RightsResponseDto;

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
