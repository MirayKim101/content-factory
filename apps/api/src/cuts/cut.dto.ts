import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Max, Min } from "class-validator";

export class CreateCutJobDto {
  @ApiProperty({
    type: Number,
    example: 1_000,
    minimum: 0,
    maximum: 2_147_483_646,
  })
  @IsInt()
  @Min(0)
  @Max(2_147_483_646)
  startMs!: number;

  @ApiProperty({
    type: Number,
    example: 5_000,
    minimum: 1,
    maximum: 2_147_483_647,
  })
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  endMs!: number;
}

class CutProgressDto {
  @ApiProperty({ type: String, example: "1000" })
  current!: string;
  @ApiProperty({ type: String, example: "4000" })
  total!: string;
  @ApiProperty({ type: String, enum: ["BYTES", "MILLISECONDS"] })
  unit!: string;
}

class CutFailureDto {
  @ApiProperty({ type: String })
  code!: string;
  @ApiProperty({ type: String })
  message!: string;
}

class CutArtifactDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;
  @ApiProperty({ type: String })
  sizeBytes!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  sha256!: string;
  @ApiProperty({ type: String, example: "video/mp4" })
  contentType!: string;
  @ApiProperty({ type: String })
  downloadUrl!: string;
}

export class CutJobDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;
  @ApiProperty({ type: String, format: "uuid" })
  sourceId!: string;
  @ApiProperty({ type: Number })
  sourceVersion!: number;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  sourceSha256!: string;
  @ApiProperty({ type: Number })
  startMs!: number;
  @ApiProperty({ type: Number })
  endMs!: number;
  @ApiProperty({
    type: String,
    enum: [
      "QUEUED",
      "RUNNING",
      "FAILED_RETRYABLE",
      "SUCCEEDED",
      "FAILED_FINAL",
    ],
  })
  state!: string;
  @ApiProperty({ type: String })
  stage!: string;
  @ApiProperty({ type: () => CutProgressDto, nullable: true })
  progress!: CutProgressDto | null;
  @ApiProperty({ type: Number })
  attempts!: number;
  @ApiProperty({ type: String, nullable: true })
  queueReason!: string | null;
  @ApiProperty({ type: String, format: "date-time" })
  admissionDeadlineAt!: string;
  @ApiProperty({ type: () => CutFailureDto, nullable: true })
  failure!: CutFailureDto | null;
  @ApiProperty({ type: String, example: "horizontal-cut-v1" })
  recipeVersion!: string;
  @ApiProperty({ type: Number })
  revision!: number;
  @ApiProperty({ type: () => CutArtifactDto, nullable: true })
  artifact!: CutArtifactDto | null;
  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: string;
}

export class CutJobPageDto {
  @ApiProperty({ type: () => [CutJobDto] })
  items!: CutJobDto[];
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
