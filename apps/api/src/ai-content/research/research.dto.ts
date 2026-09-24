import { ApiProperty } from "@nestjs/swagger";
import {
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class ResearchCitationDto {
  @IsUrl({ protocols: ["https"], require_protocol: true })
  @ApiProperty({ type: String, example: "https://example.com/source" })
  url!: string;
  @IsString()
  @MaxLength(500)
  @ApiProperty({ type: String })
  title!: string;
  @IsString()
  @MaxLength(300)
  @ApiProperty({ type: String })
  publisher!: string;
  @IsOptional()
  @IsISO8601()
  @ApiProperty({ type: String, example: "2026-09-23T00:00:00.000Z" })
  publishedAt?: string;
  @IsISO8601()
  @ApiProperty({ type: String, example: "2026-09-23T00:00:00.000Z" })
  accessedAt!: string;
  @IsString()
  @MaxLength(4_000)
  @ApiProperty({ type: String })
  excerpt!: string;
}

export class CreateResearchSuggestionDto {
  @IsString()
  @MaxLength(4_000)
  @ApiProperty({ type: String })
  query!: string;
  @IsString()
  @MaxLength(120)
  @ApiProperty({ type: String })
  sourceTitle!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResearchCitationDto)
  @ApiProperty({ type: [ResearchCitationDto] })
  citations!: ResearchCitationDto[];
}
