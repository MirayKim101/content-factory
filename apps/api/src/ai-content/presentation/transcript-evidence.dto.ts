import { ApiProperty } from "@nestjs/swagger";

export class TranscriptSegmentDto {
  @ApiProperty({ type: Number, minimum: 0 }) ordinal!: number;
  @ApiProperty({ type: Number, minimum: 0 }) startMs!: number;
  @ApiProperty({ type: Number, minimum: 1 }) endMs!: number;
  @ApiProperty({ type: String, minLength: 1, maxLength: 20_000 }) text!: string;
}

export class LocalTranscriptFixtureDto {
  @ApiProperty({ type: String, example: "ru" }) language!: string;
  @ApiProperty({ type: [TranscriptSegmentDto], maxItems: 10_000 })
  segments!: TranscriptSegmentDto[];
}

export class CreateTranscriptEvidenceDto {
  @ApiProperty({ type: String, format: "uuid" })
  sourceContextRevisionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutPromptRevisionId!: string;
  @ApiProperty({ type: String, example: "ru" }) language!: string;
  @ApiProperty({ type: LocalTranscriptFixtureDto })
  fixture!: LocalTranscriptFixtureDto;
}

export class TranscriptInputCaptureDto {
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) sourceVersion!: number;
  @ApiProperty({ type: String }) sourceSha256!: string;
  @ApiProperty({ type: Number, minimum: 1 })
  sourceAuthorizationRevision!: number;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({ type: String, format: "uuid" }) cutResultArtifactId!: string;
  @ApiProperty({ type: String }) cutResultSha256!: string;
  @ApiProperty({ type: String }) cutResultSizeBytes!: string;
  @ApiProperty({ type: Number, minimum: 0 }) cutStartMs!: number;
  @ApiProperty({ type: Number, minimum: 1 }) cutEndMs!: number;
  @ApiProperty({ type: String, format: "uuid" })
  creatorProfileRevisionId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) creatorProfileRevisionNo!: number;
  @ApiProperty({ type: String, format: "uuid" })
  sourceContextRevisionId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) sourceContextRevisionNo!: number;
  @ApiProperty({ type: String, format: "uuid" }) cutPromptRevisionId!: string;
  @ApiProperty({ type: Number, minimum: 1 }) cutPromptRevisionNo!: number;
}

export class TranscriptArtifactDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, enum: ["application/json"] })
  contentType!: string;
  @ApiProperty({ type: Number, minimum: 1 }) sizeBytes!: number;
  @ApiProperty({ type: String }) sha256!: string;
  @ApiProperty({ type: String }) adapterVersion!: string;
  @ApiProperty({ type: String }) language!: string;
  @ApiProperty({ type: [TranscriptSegmentDto] }) segments!: TranscriptSegmentDto[];
}

export class TranscriptFailureDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class TranscriptEvidenceDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({
    type: String,
    enum: ["QUEUED", "PROCESSING", "READY", "FAILED_FINAL"],
  })
  state!: string;
  @ApiProperty({ type: String, enum: ["editorial-transcript-v1"] })
  contractVersion!: string;
  @ApiProperty({ type: String }) adapterVersion!: string;
  @ApiProperty({ type: String }) language!: string;
  @ApiProperty({ type: TranscriptInputCaptureDto }) input!: TranscriptInputCaptureDto;
  @ApiProperty({ type: TranscriptArtifactDto, nullable: true })
  artifact!: TranscriptArtifactDto | null;
  @ApiProperty({ type: TranscriptFailureDto, nullable: true })
  failure!: TranscriptFailureDto | null;
}

export class TranscriptEvidenceErrorDetailDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class TranscriptEvidenceErrorResponseDto {
  @ApiProperty({ type: TranscriptEvidenceErrorDetailDto })
  error!: TranscriptEvidenceErrorDetailDto;
}
