import { Type } from "class-transformer";
import { IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateAssemblyRenderDto {
  @ApiProperty({ type: "integer", minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  recipeRevision!: number;
}

export class AssemblyRenderListQueryDto {
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

export class AssemblyRenderInputResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: ["CUT", "INTRO", "OUTRO", "ADVERTISEMENT", "BANNER"] })
  role!: string;
  @ApiProperty({ type: "integer", nullable: true }) revision!: number | null;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) sizeBytes!: string;
  @ApiProperty({ type: "integer", nullable: true }) durationMs!: number | null;
}

export class AssemblyRenderProgressResponseDto {
  @ApiProperty({ enum: ["assembly-progress-v1"] }) schemaVersion!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) attemptNumber!: number;
  @ApiProperty({
    enum: [
      "DOWNLOAD",
      "AUDIO_ANALYSIS",
      "ENCODE",
      "OUTPUT_PROBE",
      "OUTPUT_HASH",
      "UPLOAD",
      "FINALIZE",
    ],
  })
  phase!: string;
  @ApiProperty({ type: "integer", minimum: 0, maximum: 10000 })
  basisPoints!: number;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class AssemblyRenderFailureResponseDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
  @ApiProperty({ type: Boolean }) retryable!: boolean;
}

export class AssemblyRenderJobResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) revision!: number;
  @ApiProperty({
    enum: ["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"],
  })
  state!: string;
  @ApiProperty({ type: "integer", minimum: 0 }) attempt!: number;
  @ApiProperty({ type: "integer", minimum: 0 }) retryBudget!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  nextAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) admissionReason!:
    string | null;
  @ApiProperty({ type: AssemblyRenderProgressResponseDto, nullable: true })
  progress!: AssemblyRenderProgressResponseDto | null;
  @ApiProperty({ type: AssemblyRenderFailureResponseDto, nullable: true })
  failure!: AssemblyRenderFailureResponseDto | null;
}

export class AssemblyRenderResultResponseDto {
  @ApiProperty({ type: String }) filename!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) sizeBytes!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: "integer" }) durationMs!: number;
  @ApiProperty({ type: "integer" }) width!: number;
  @ApiProperty({ type: "integer" }) height!: number;
  @ApiProperty({ type: "integer" }) fpsNumerator!: number;
  @ApiProperty({ type: "integer" }) fpsDenominator!: number;
  @ApiProperty({ type: String }) videoCodec!: string;
  @ApiProperty({ type: String }) pixelFormat!: string;
  @ApiProperty({ type: String }) audioCodec!: string;
  @ApiProperty({ type: "integer" }) audioSampleRate!: number;
  @ApiProperty({ type: "integer" }) audioChannels!: number;
  @ApiProperty({ type: Number, nullable: true }) integratedLoudnessLufs!:
    number | null;
  @ApiProperty({ type: Number, nullable: true }) truePeakDbtp!: number | null;
  @ApiProperty({ type: String }) normalizationProfileResult!: string;
  @ApiProperty({ type: String }) ffmpegVersion!: string;
  @ApiProperty({ type: String }) ffprobeVersion!: string;
  @ApiProperty({ type: String, format: "date-time" }) completedAt!: string;
  @ApiProperty({ type: String, format: "uri-reference" }) downloadUrl!: string;
}

export class AssemblyRenderResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) sourceVersion!: number;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutResultArtifactId!: string;
  @ApiProperty({ type: String, format: "uuid" }) assemblyRecipeId!: string;
  @ApiProperty({ type: String, format: "uuid" }) recipeRevisionId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) recipeRevision!: number;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  configurationFingerprint!: string;
  @ApiProperty({ enum: ["horizontal-render-v1"] })
  renderContractVersion!: string;
  @ApiProperty({ enum: ["youtube-stereo-v1"] }) audioProfileVersion!: string;
  @ApiProperty({ enum: ["youtube-h264-v1"] }) encodingProfileVersion!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) expectedDurationMs!: number;
  @ApiProperty({ type: [AssemblyRenderInputResponseDto] })
  inputs!: AssemblyRenderInputResponseDto[];
  @ApiProperty({ type: AssemblyRenderJobResponseDto })
  job!: AssemblyRenderJobResponseDto;
  @ApiProperty({ type: AssemblyRenderResultResponseDto, nullable: true })
  result!: AssemblyRenderResultResponseDto | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class AssemblyRenderListResponseDto {
  @ApiProperty({ type: [AssemblyRenderResponseDto] })
  items!: AssemblyRenderResponseDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true }) nextCursor!:
    string | null;
}
