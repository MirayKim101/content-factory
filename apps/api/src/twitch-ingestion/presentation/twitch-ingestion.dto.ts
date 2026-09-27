import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsString, Length, Matches, Max, Min } from "class-validator";

export class CreateTwitchIngestChannelDto {
  @ApiProperty()
  @IsString()
  @Length(1, 64)
  @Matches(/^\d+$/)
  broadcasterId!: string;
  @ApiProperty()
  @IsString()
  @Length(1, 64)
  @Matches(/^[a-zA-Z0-9_]+$/)
  broadcasterLogin!: string;
  @ApiProperty() @IsString() @Length(1, 120) broadcasterDisplayName!: string;
  @ApiProperty({ minimum: 60, maximum: 86400, default: 300 })
  @IsInt()
  @Min(60)
  @Max(86400)
  ingestDelaySeconds = 300;
}

export class TwitchIngestChannelResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) broadcasterId!: string;
  @ApiProperty({ type: String }) broadcasterLogin!: string;
  @ApiProperty({ type: String }) broadcasterDisplayName!: string;
  @ApiProperty({ type: String, enum: ["ENABLED", "REVOKED"] }) state!: string;
  @ApiProperty({ type: Number }) ingestDelaySeconds!: number;
  @ApiProperty({ type: String, nullable: true }) reconciliationCursor!:
    string | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  lastReconciledAt!: Date | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  lastOnlineAt!: Date | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  lastOfflineAt!: Date | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: Date;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: Date;
}
