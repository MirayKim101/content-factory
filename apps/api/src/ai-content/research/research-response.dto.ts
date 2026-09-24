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
  @ApiProperty({ type: String, enum: ["CURRENT", "STALE"] }) freshness!:
    "CURRENT" | "STALE";
  @ApiProperty({ type: [ResearchCitationResponseDto] })
  citations!: ResearchCitationResponseDto[];
}

export class ResearchTextSuggestionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) description!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ type: String }) basisVersion!: string;
  @ApiProperty({ type: [String] }) citationIds!: string[];
  @ApiProperty({ type: "array", items: { type: "object" } })
  claims!: Array<{ text: string; citationIds: string[] }>;
}

export class ResearchSuggestionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) intentId!: string;
  @ApiProperty({ type: ResearchSnapshotResponseDto })
  snapshot!: ResearchSnapshotResponseDto;
  @ApiProperty({ type: ResearchTextSuggestionResponseDto })
  suggestion!: ResearchTextSuggestionResponseDto;
}
