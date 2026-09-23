import { ApiProperty } from "@nestjs/swagger";

export class ResearchCitationResponseDto {
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) publisher!: string;
  @ApiProperty({ type: String, format: "date-time" }) retrievedAt!: string;
  @ApiProperty({ type: String }) excerpt!: string;
}

export class ResearchSnapshotResponseDto {
  @ApiProperty({ type: String, enum: ["editorial-research-v1"] }) contractVersion!: "editorial-research-v1";
  @ApiProperty({ type: String }) adapterVersion!: string;
  @ApiProperty({ type: String }) query!: string;
  @ApiProperty({ type: String, enum: ["CURRENT", "STALE"] }) freshness!: "CURRENT" | "STALE";
  @ApiProperty({ type: [ResearchCitationResponseDto] }) citations!: ResearchCitationResponseDto[];
}

export class ResearchTextSuggestionResponseDto {
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) description!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ type: String }) basisVersion!: string;
  @ApiProperty({ type: String, enum: ["AI_ASSISTED", "MIXED"] }) mode!: "AI_ASSISTED" | "MIXED";
}

export class ResearchSuggestionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) intentId!: string;
  @ApiProperty({ type: ResearchSnapshotResponseDto }) snapshot!: ResearchSnapshotResponseDto;
  @ApiProperty({ type: ResearchTextSuggestionResponseDto }) suggestion!: ResearchTextSuggestionResponseDto;
}
