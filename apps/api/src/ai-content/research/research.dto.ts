import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Max,
  Min,
  IsInt,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import {
  PUBLIC_CITATION_PUBLISHER_MAX_LENGTH,
  PUBLIC_CITATION_TITLE_MAX_LENGTH,
} from "@content-factory/contracts";

export class ResearchCitationDto {
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @ApiProperty({ type: String, example: "https://example.com/source" })
  url!: string;
  @IsString()
  @MaxLength(PUBLIC_CITATION_TITLE_MAX_LENGTH)
  @ApiProperty({ type: String, maxLength: PUBLIC_CITATION_TITLE_MAX_LENGTH })
  title!: string;
  @IsString()
  @MaxLength(PUBLIC_CITATION_PUBLISHER_MAX_LENGTH)
  @ApiProperty({
    type: String,
    maxLength: PUBLIC_CITATION_PUBLISHER_MAX_LENGTH,
  })
  publisher!: string;
  @IsOptional()
  @IsISO8601()
  @ApiProperty({ type: String, example: "2026-09-23T00:00:00.000Z" })
  publishedAt?: string;
  @IsString()
  @MaxLength(4_000)
  @ApiProperty({ type: String })
  excerpt!: string;
}

export class ApplyResearchMetadataDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_646)
  @ApiProperty({ type: "integer", minimum: 1 })
  expectedEditorialRevision!: number;

  @IsString()
  @MaxLength(200)
  @ApiProperty({ type: String, maxLength: 200 })
  title!: string;

  @IsString()
  @MaxLength(5_000)
  @ApiProperty({ type: String, maxLength: 5_000 })
  description!: string;

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ApiProperty({ type: [String], maxItems: 30 })
  tags!: string[];
}

export class CreateResearchSuggestionDto {
  @IsString()
  @MaxLength(4_000)
  @ApiProperty({ type: String })
  query!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResearchCitationDto)
  @ApiProperty({ type: [ResearchCitationDto] })
  citations!: ResearchCitationDto[];
}
