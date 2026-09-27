import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class CreateVerticalRenderDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  cutPipelineJobId!: string;
}

export class VerticalRenderResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, enum: ["CENTER_CROP"] }) framingMode!: string;
  @ApiProperty({ type: Number }) outputWidth!: number;
  @ApiProperty({ type: Number }) outputHeight!: number;
  @ApiProperty({ type: String }) renderContractVersion!: string;
  @ApiProperty({ type: Object }) job!: object;
  @ApiProperty({ type: Object, nullable: true }) result!: object | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: Date;
}
