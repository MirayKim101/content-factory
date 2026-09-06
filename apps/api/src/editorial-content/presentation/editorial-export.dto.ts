import { Type } from "class-transformer";
import { IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class EditorialExportListQueryDto {
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

export class EditorialExportProgressResponseDto {
  @ApiProperty({ enum: ["editorial-export-progress-v1"] })
  schemaVersion!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) attemptNumber!: number;
  @ApiProperty({
    enum: ["READ_INPUTS", "WRITE_ARCHIVE", "OUTPUT_HASH", "UPLOAD", "FINALIZE"],
  })
  phase!: string;
  @ApiProperty({ type: "integer", minimum: 0, maximum: 10000 })
  basisPoints!: number;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class EditorialExportFailureResponseDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
  @ApiProperty({ type: Boolean }) retryable!: boolean;
}

export class EditorialExportJobResponseDto {
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
  @ApiProperty({ type: EditorialExportProgressResponseDto, nullable: true })
  progress!: EditorialExportProgressResponseDto | null;
  @ApiProperty({ type: EditorialExportFailureResponseDto, nullable: true })
  failure!: EditorialExportFailureResponseDto | null;
}

export class EditorialExportResultResponseDto {
  @ApiProperty({ type: String }) filename!: string;
  @ApiProperty({ type: String, pattern: "^\\d+$" }) sizeBytes!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: Object }) manifest!: object;
  @ApiProperty({ type: String, format: "date-time" }) completedAt!: string;
  @ApiProperty({ type: String, format: "uri-reference" }) downloadUrl!: string;
}

export class EditorialExportResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) sourceVersion!: number;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, format: "uuid" }) approvalId!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  approvalCandidateFingerprint!: string;
  @ApiProperty({ type: String, format: "uuid" })
  editorialPackageRevisionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) recipeRevisionId!: string;
  @ApiProperty({ type: String, format: "uuid" })
  assemblyRenderResultId!: string;
  @ApiProperty({ enum: ["editorial-export-zip-v1"] })
  exportContractVersion!: string;
  @ApiProperty({ type: Boolean }) approvalCurrent!: boolean;
  @ApiProperty({ type: EditorialExportJobResponseDto })
  job!: EditorialExportJobResponseDto;
  @ApiProperty({ type: EditorialExportResultResponseDto, nullable: true })
  result!: EditorialExportResultResponseDto | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class EditorialExportListResponseDto {
  @ApiProperty({ type: [EditorialExportResponseDto] })
  items!: EditorialExportResponseDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true }) nextCursor!:
    string | null;
}
