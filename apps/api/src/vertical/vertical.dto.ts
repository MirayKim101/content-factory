import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class CreateVerticalRenderDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  cutPipelineJobId!: string;
}

export class VerticalCapabilitiesResponseDto {
  @ApiProperty({ type: Boolean }) renderEnabled!: boolean;
}

export class VerticalJobResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({
    enum: ["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"],
  })
  state!: string;
  @ApiProperty({ type: Number }) attemptCount!: number;
  @ApiProperty({ type: Number }) retryBudget!: number;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) failureMessage!: string | null;
}

export class VerticalApprovalSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: Date;
}

export class VerticalResultResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) artifactId!: string;
  @ApiProperty({ type: Number, example: 1080 }) width!: number;
  @ApiProperty({ type: Number, example: 1920 }) height!: number;
  @ApiProperty({ type: String, example: "720885" }) sizeBytes!: string;
  @ApiProperty({ type: String, format: "uri-reference" }) downloadUrl!: string;
  @ApiProperty({ type: String, format: "date-time" }) completedAt!: Date;
  @ApiProperty({ type: VerticalApprovalSummaryDto, nullable: true })
  approval!: VerticalApprovalSummaryDto | null;
}

export class VerticalRenderResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, enum: ["CENTER_CROP"] }) framingMode!: string;
  @ApiProperty({ type: Number }) outputWidth!: number;
  @ApiProperty({ type: Number }) outputHeight!: number;
  @ApiProperty({ type: String }) renderContractVersion!: string;
  @ApiProperty({ type: VerticalJobResponseDto }) job!: VerticalJobResponseDto;
  @ApiProperty({ type: VerticalResultResponseDto, nullable: true })
  result!: VerticalResultResponseDto | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: Date;
}
