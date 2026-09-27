import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ClipTranscriptCueDto {
  @IsInt()
  @Min(0)
  @ApiProperty({ type: "integer", minimum: 0 })
  startMs!: number;
  @IsInt() @Min(1) @ApiProperty({ type: "integer", minimum: 1 }) endMs!: number;
  @IsString()
  @MaxLength(4_000)
  @ApiProperty({ type: String, maxLength: 4_000 })
  text!: string;
}

export class CreateClipGenerationDto {
  @IsString()
  @MaxLength(300)
  @ApiProperty({ type: String, maxLength: 300 })
  sourceTitle!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => ClipTranscriptCueDto)
  @ApiProperty({ type: [ClipTranscriptCueDto] })
  transcript!: ClipTranscriptCueDto[];
  @IsInt()
  @Min(1)
  @Max(20)
  @ApiProperty({ type: "integer", minimum: 1, maximum: 20 })
  maximumSuggestions!: number;
  @IsInt()
  @Min(5_000)
  @Max(600_000)
  @ApiProperty({ type: "integer" })
  minimumClipDurationMs!: number;
  @IsInt()
  @Min(5_000)
  @Max(600_000)
  @ApiProperty({ type: "integer" })
  maximumClipDurationMs!: number;
  @IsString()
  @Matches(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
  @ApiProperty({ type: String })
  language!: string;
  @IsBoolean()
  @ApiProperty({
    type: Boolean,
    description:
      "Explicit consent to transfer transcript text to the configured external provider.",
  })
  externalProviderTransferAllowed!: boolean;
}
