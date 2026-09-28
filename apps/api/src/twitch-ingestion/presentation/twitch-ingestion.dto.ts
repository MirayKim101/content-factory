import { ApiProperty } from "@nestjs/swagger";
import {
  IsBoolean,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

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
  lastIngestClaimedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  lastOnlineAt!: Date | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  lastOfflineAt!: Date | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: Date;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: Date;
}

export class TwitchIngestionCapabilitiesDto {
  @ApiProperty({ type: Boolean }) ingestionEnabled!: boolean;
  @ApiProperty({ type: Boolean }) autoIngestEnabled!: boolean;
}

export class TwitchVodCandidateChannelDto {
  @ApiProperty({ type: String }) broadcasterLogin!: string;
  @ApiProperty({ type: String }) broadcasterDisplayName!: string;
}

export class TwitchVodCandidateResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) channelId!: string;
  @ApiProperty({ type: TwitchVodCandidateChannelDto })
  channel!: TwitchVodCandidateChannelDto;
  @ApiProperty({ type: String }) providerVideoId!: string;
  @ApiProperty({ type: String, nullable: true }) streamId!: string | null;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ enum: ["archive", "highlight", "upload"] }) vodType!: string;
  @ApiProperty({ type: Number, minimum: 1 }) durationSeconds!: number;
  @ApiProperty({ type: String, format: "date-time" }) startedAt!: Date;
  @ApiProperty({ type: String, format: "date-time" }) publishedAt!: Date;
  @ApiProperty({ type: String, format: "date-time" })
  availableForIngestAt!: Date;
  @ApiProperty({
    enum: ["WAITING_DELAY", "READY_FOR_INGEST", "IMPORTED", "IGNORED"],
  })
  state!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  importedProjectId!: string | null;
  @ApiProperty({ type: () => TwitchVodIngestIntentResponseDto, nullable: true })
  ingestIntent!: TwitchVodIngestIntentResponseDto | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: Date;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: Date;
}

export class LinkTwitchVodProjectDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  projectId!: string;
  @ApiProperty({
    type: Boolean,
    description:
      "Operator confirms that the uploaded project source is this exact Twitch VOD.",
  })
  @IsBoolean()
  sourceMatchConfirmed!: boolean;
}

export class StartTwitchVodIngestDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 160 })
  @IsString()
  @Length(1, 160)
  @Matches(/\S/)
  projectName!: string;
}

export class TwitchVodIngestIntentResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) candidateId!: string;
  @ApiProperty({ type: String }) projectName!: string;
  @ApiProperty({
    enum: [
      "QUEUED",
      "DOWNLOADING",
      "UPLOADING",
      "RETRY_WAIT",
      "READY",
      "FAILED_FINAL",
      "CANCELED",
    ],
  })
  state!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  projectId!: string | null;
  @ApiProperty({ type: String }) downloadedBytes!: string;
  @ApiProperty({ type: String, nullable: true }) totalBytes!: string | null;
  @ApiProperty({ type: Number }) attemptCount!: number;
  @ApiProperty({ type: String, nullable: true }) failureCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) failureMessage!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: Date;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: Date;
}
