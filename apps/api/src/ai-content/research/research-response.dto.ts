import { ApiProperty } from "@nestjs/swagger";

export class ResearchCitationResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) publisher!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  publishedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) accessedAt!: string;
  @ApiProperty({ type: String }) excerpt!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) checksum!: string;
}

export class ResearchSnapshotResponseDto {
  @ApiProperty({ type: String, enum: ["editorial-research-v1"] })
  contractVersion!: "editorial-research-v1";
  @ApiProperty({ type: String }) adapterVersion!: string;
  @ApiProperty({ type: String }) query!: string;
  @ApiProperty({ type: String, enum: ["CURRENT", "STALE"] })
  freshness!: "CURRENT" | "STALE";
  @ApiProperty({ type: String, format: "date-time" }) searchedAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) freshUntil!: string;
  @ApiProperty({ type: String }) freshnessPolicyVersion!: string;
  @ApiProperty({ type: [ResearchCitationResponseDto] })
  citations!: ResearchCitationResponseDto[];
}

export class ResearchClaimResponseDto {
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ type: [String] }) citationIds!: string[];
}

export class ResearchTextSuggestionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) description!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ type: String }) basisVersion!: string;
  @ApiProperty({ type: [String] }) citationIds!: string[];
  @ApiProperty({ type: [ResearchClaimResponseDto] })
  claims!: ResearchClaimResponseDto[];
}

export class ResearchCostResponseDto {
  @ApiProperty({ type: String, pattern: "^\\d+$" })
  directCostMicrousd!: string;
  @ApiProperty({ type: String }) basisVersion!: string;
}

export class ResearchFailureResponseDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class ResearchSuggestionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) transcriptIntentId!: string;
  @ApiProperty({
    type: String,
    enum: ["QUEUED", "PROCESSING", "READY", "FAILED_FINAL"],
  })
  state!: "QUEUED" | "PROCESSING" | "READY" | "FAILED_FINAL";
  @ApiProperty({ type: ResearchSnapshotResponseDto })
  snapshot!: ResearchSnapshotResponseDto;
  @ApiProperty({ type: ResearchTextSuggestionResponseDto, nullable: true })
  suggestion!: ResearchTextSuggestionResponseDto | null;
  @ApiProperty({ type: ResearchCostResponseDto, nullable: true })
  cost!: ResearchCostResponseDto | null;
  @ApiProperty({ type: ResearchFailureResponseDto, nullable: true })
  failure!: ResearchFailureResponseDto | null;
}

export class ResearchSuggestionListResponseDto {
  @ApiProperty({ type: [ResearchSuggestionResponseDto] })
  items!: ResearchSuggestionResponseDto[];
}

export class ResearchMetadataApplyResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) packageId!: string;
  @ApiProperty({ type: String, format: "uuid" }) packageRevisionId!: string;
  @ApiProperty({ type: "integer", minimum: 1 }) revision!: number;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) description!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ type: String, enum: ["AI_ASSISTED", "MIXED"] })
  metadataMode!: "AI_ASSISTED" | "MIXED";
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  thumbnailAssetId!: string | null;
}
