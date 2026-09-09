import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CutSegmentDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  clientSegmentId!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  @IsInt()
  @Min(0)
  startMs!: number;

  @ApiProperty({ type: Number, minimum: 1 })
  @IsInt()
  @Min(1)
  endMs!: number;
}

export class CreateCutsDto {
  @ApiProperty({ type: () => [CutSegmentDto], minItems: 1, maxItems: 20 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CutSegmentDto)
  segments!: CutSegmentDto[];
}

class JobFailureDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
  @ApiProperty({ type: Boolean }) retryable!: boolean;
}

class JobResultDto {
  @ApiProperty({ type: String }) filename!: string;
  @ApiProperty({ type: String, description: "Decimal bigint string." })
  sizeBytes!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: String, format: "uri-reference" }) downloadUrl!: string;
}

export class PipelineJobResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) clientSegmentId!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({
    type: String,
    enum: ["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"],
  })
  state!: string;
  @ApiProperty({ type: Number }) startMs!: number;
  @ApiProperty({ type: Number }) endMs!: number;
  @ApiPropertyOptional({ type: Number }) processedMs?: number;
  @ApiPropertyOptional({ type: Number }) totalMs?: number;
  @ApiProperty({ type: Number }) attempt!: number;
  @ApiProperty({ type: Number }) retryBudget!: number;
  @ApiPropertyOptional({ type: () => JobFailureDto }) failure?: JobFailureDto;
  @ApiPropertyOptional({ type: () => JobResultDto }) result?: JobResultDto;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class CreateCutsResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) requestId!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: () => [PipelineJobResponseDto] })
  jobs!: PipelineJobResponseDto[];
}

export class ProjectCutJobsResponseDto {
  @ApiProperty({ type: () => [PipelineJobResponseDto] })
  items!: PipelineJobResponseDto[];
}

export class IdempotencyHeaderDto {
  @IsString()
  @MaxLength(200)
  value!: string;
}
