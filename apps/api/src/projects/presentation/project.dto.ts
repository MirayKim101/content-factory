import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Allow,
  Equals,
  IsIn,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
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
      "Ignored legacy upload field. Authorization is a separate step.",
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

export class SourceAuthorizationResponseDto {
  @ApiProperty({ type: Number, minimum: 1 }) sourceVersion!: number;
  @ApiProperty({ type: String, enum: ["NOT_REVIEWED", "CLEARED"] })
  status!: string;
  @ApiProperty({
    type: Boolean,
    description:
      "Policy-aware authorization eligibility for playback and processing.",
  })
  usable!: boolean;
  @ApiPropertyOptional({
    type: String,
    enum: [
      "LEGACY_ATTESTATION",
      "OPERATOR_ATTESTATION",
      "LOCAL_DEVELOPMENT_AUTO",
    ],
  })
  basis?: string;
  @ApiPropertyOptional({ type: String }) declarationVersion?: string;
  @ApiPropertyOptional({ type: String, format: "date-time" })
  decidedAt?: string;
  @ApiProperty({ type: Number, minimum: 1 }) revision!: number;
}

export class AttestSourceAuthorizationDto {
  @ApiProperty({ type: Number, minimum: 1 })
  @IsInt()
  @Min(1)
  sourceVersion!: number;

  @ApiProperty({ type: Number, minimum: 1 })
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @ApiProperty({ type: String, enum: ["source-authorization-v1"] })
  @IsString()
  declarationVersion!: string;

  @ApiProperty({ type: Boolean, enum: [true] })
  @IsBoolean()
  attested!: boolean;
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

  @ApiPropertyOptional({
    type: Number,
    example: 7200000,
    description: "Authoritative FFprobe duration in integer milliseconds.",
  })
  durationMs?: number;

  @ApiPropertyOptional({
    type: String,
    enum: ["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"],
  })
  probeState?: string;

  @ApiPropertyOptional({ type: () => FailureResponseDto })
  probeFailure?: FailureResponseDto;

  @ApiProperty({ type: () => SourceAuthorizationResponseDto })
  authorization!: SourceAuthorizationResponseDto;
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

  @ApiPropertyOptional({
    type: () => RightsResponseDto,
    nullable: true,
    deprecated: true,
  })
  rights!: RightsResponseDto | null;

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

export class ListProjectsQueryDto {
  @ApiPropertyOptional({
    type: String,
    description:
      "Opaque cursor returned by the previous page. Do not construct it manually.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,512}$/)
  cursor?: string;

  @ApiPropertyOptional({
    type: String,
    default: "20",
    pattern: "^(?:[1-9]|[1-4][0-9]|50)$",
    description: "Page size from 1 to 50.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/)
  limit?: string;

  @ApiPropertyOptional({
    type: String,
    enum: ["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"],
  })
  @IsOptional()
  @IsIn(["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"])
  status?: "SOURCE_PENDING" | "SOURCE_READY" | "FAILED_FINAL";

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 200,
    description:
      "Case-insensitive search in project name and original filename. Whitespace is trimmed.",
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Matches(/^[^\p{Cc}]*$/u)
  q?: string;
}

class ProjectLibrarySourceDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({
    type: String,
    enum: ["PENDING", "READY", "FAILED_FINAL"],
  })
  status!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  sourceVersion!: number;

  @ApiProperty({
    type: String,
    format: "date-time",
    description: "When the source was added to the media library.",
  })
  addedAt!: string;

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

  @ApiPropertyOptional({ type: Number, example: 7200000 })
  durationMs?: number;

  @ApiPropertyOptional({
    type: String,
    enum: ["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"],
  })
  probeState?: string;

  @ApiProperty({ type: () => SourceAuthorizationResponseDto })
  authorization!: SourceAuthorizationResponseDto;
}

class CutJobCountsDto {
  @ApiProperty({ type: Number, example: 5 })
  total!: number;

  @ApiProperty({ type: Number, example: 2 })
  ready!: number;

  @ApiProperty({ type: Number, example: 1 })
  failed!: number;
}

export class ProjectLibraryItemDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({
    type: String,
    enum: ["SOURCE_PENDING", "SOURCE_READY", "FAILED_FINAL"],
  })
  status!: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: string;

  @ApiProperty({ type: () => ProjectLibrarySourceDto })
  source!: ProjectLibrarySourceDto;

  @ApiProperty({ type: () => CutJobCountsDto })
  cutJobCounts!: CutJobCountsDto;
}

export class ProjectLibraryPageDto {
  @ApiProperty({ type: () => ProjectLibraryItemDto, isArray: true })
  items!: ProjectLibraryItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Opaque cursor for the next page, or null on the last page.",
  })
  nextCursor!: string | null;
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
      "INVALID_CURSOR",
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
