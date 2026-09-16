import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

export class CreateFrameEvidenceDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  sourceContextRevisionId!: string;
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  cutPromptRevisionId!: string;
}

export class FrameEvidenceIdentityDto {
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: Number }) sourceVersion!: number;
  @ApiProperty({ type: String }) sourceSha256!: string;
  @ApiProperty({ type: Number }) sourceAuthorizationRevision!: number;
  @ApiProperty({ type: String }) sourceAuthorizationBasis!: string;
  @ApiProperty({ type: String }) sourceAuthorizationDeclarationVersion!: string;
  @ApiProperty({ type: String, format: "date-time" })
  sourceAuthorizationDecidedAt!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutResultArtifactId!: string;
  @ApiProperty({ type: String }) cutResultSha256!: string;
  @ApiProperty({ type: String, description: "Exact decimal byte count." })
  cutResultSizeBytes!: string;
  @ApiProperty({ type: Number }) cutStartMs!: number;
  @ApiProperty({ type: Number }) cutEndMs!: number;
  @ApiProperty({ type: String, format: "uuid" }) creatorProfileId!: string;
  @ApiProperty({ type: String, format: "uuid" })
  creatorProfileRevisionId!: string;
  @ApiProperty({ type: Number }) creatorProfileRevisionNo!: number;
  @ApiProperty({ type: String, format: "uuid" }) sourceContextId!: string;
  @ApiProperty({ type: String, format: "uuid" })
  sourceContextRevisionId!: string;
  @ApiProperty({ type: Number }) sourceContextRevisionNo!: number;
  @ApiProperty({ type: String, format: "uuid" }) cutPromptId!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutPromptRevisionId!: string;
  @ApiProperty({ type: Number }) cutPromptRevisionNo!: number;
}

export class FrameMeasurementDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 2 }) ordinal!: number;
  @ApiProperty({ type: Number }) requestedCutMs!: number;
  @ApiProperty({ type: Number }) requestedSourceMs!: number;
  @ApiProperty({
    type: Number,
    description:
      "Measured normalized decoded frame PTS; never requested seek time.",
  })
  actualPtsTicks!: number;
  @ApiProperty({ type: Number, enum: [1] }) timeBaseNumerator!: number;
  @ApiProperty({ type: Number, enum: [1000000] }) timeBaseDenominator!: number;
  @ApiProperty({ type: Number }) actualCutMs!: number;
  @ApiProperty({
    type: Number,
    description:
      "Cut start plus normalized actual time, not original source PTS.",
  })
  mappedSourceMs!: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 640 }) width!: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 640 }) height!: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 4194304 })
  sizeBytes!: number;
  @ApiProperty({ type: String }) sha256!: string;
  @ApiProperty({ type: String, enum: ["image/jpeg"] }) contentType!: string;
  @ApiProperty({ type: String, enum: ["quartiles-jpeg-640-v1"] })
  recipeVersion!: string;
  @ApiProperty({ type: String, enum: ["ffmpeg-frame-extractor-v1"] })
  extractorVersion!: string;
  @ApiProperty({ type: String }) ffmpegVersion!: string;
}
export class EvidenceFrameDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: FrameMeasurementDto }) measurement!: FrameMeasurementDto;
}
export class FrameCurrentUseDto {
  @ApiProperty({ type: Boolean }) usableForGeneration!: boolean;
  @ApiProperty({ type: [String] }) blockers!: string[];
  @ApiProperty({ type: String, nullable: true }) contextPolicyFingerprint!:
    string | null;
}
export class FrameContentAccessDto {
  @ApiProperty({ type: Boolean }) bytesReadable!: boolean;
  @ApiProperty({
    type: String,
    enum: ["SOURCE_AUTHORIZATION_REQUIRED"],
    nullable: true,
  })
  blocker!: string | null;
}
export class FrameProgressDto {
  @ApiProperty({ type: String, enum: ["editorial-frame-progress-v1"] })
  schemaVersion!: string;
  @ApiProperty({
    type: String,
    enum: ["READ_INPUT", "EXTRACT", "HASH", "UPLOAD", "FINALIZE"],
  })
  phase!: string;
  @ApiProperty({ type: Number, minimum: 0, maximum: 3 })
  completedFrameCount!: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 10000 })
  basisPoints!: number;
}
export class FrameFailureDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
}
export class FrameEvidenceJobDto {
  @ApiProperty({
    type: String,
    enum: ["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"],
  })
  state!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number }) attempt!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  nextAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) admissionReason!:
    string | null;
  @ApiProperty({ type: FrameFailureDto, nullable: true })
  failure!: FrameFailureDto | null;
  @ApiProperty({ type: FrameProgressDto, nullable: true })
  progress!: FrameProgressDto | null;
}
export class FrameEvidenceDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) pipelineJobId!: string;
  @ApiProperty({ type: FrameEvidenceIdentityDto })
  identity!: FrameEvidenceIdentityDto;
  @ApiProperty({ type: String, enum: ["editorial-sparse-frames-v1"] })
  contractVersion!: string;
  @ApiProperty({ type: String, enum: ["quartiles-jpeg-640-v1"] })
  recipeVersion!: string;
  @ApiProperty({ type: [Number], minItems: 3, maxItems: 3 })
  requestedPositionsMs!: number[];
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: FrameCurrentUseDto }) currentUse!: FrameCurrentUseDto;
  @ApiProperty({ type: FrameContentAccessDto })
  contentAccess!: FrameContentAccessDto;
  @ApiProperty({ type: FrameEvidenceJobDto }) job!: FrameEvidenceJobDto;
  @ApiProperty({ type: [EvidenceFrameDto] }) frames!: EvidenceFrameDto[];
}
export class FrameEvidenceListDto {
  @ApiProperty({ type: [FrameEvidenceDto] }) items!: FrameEvidenceDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class FrameEvidenceErrorDetailDto {
  @ApiProperty({
    type: String,
    description:
      "Safe operation code, including FRAME_CONTEXT_REQUIRED, SOURCE_AUTHORIZATION_REQUIRED, IDEMPOTENCY_CONFLICT, EDITORIAL_FRAMES_DISABLED, FRAME_CONTENT_INVALID, FRAME_STORAGE_UNAVAILABLE, RANGE_NOT_SATISFIABLE and validation/cursor errors.",
  })
  code!: string;
  @ApiProperty({ type: String }) message!: string;
}
export class FrameEvidenceErrorResponseDto {
  @ApiProperty({ type: FrameEvidenceErrorDetailDto })
  error!: FrameEvidenceErrorDetailDto;
}
