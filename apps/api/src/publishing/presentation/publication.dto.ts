import { Type } from "class-transformer";
import {
  Equals,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const platforms = ["LOCAL_DRY_RUN", "YOUTUBE", "TIKTOK"] as const;
const contentKinds = ["EDITORIAL_EXPORT", "VERTICAL_RESULT"] as const;

export class PublishingCapabilitiesResponseDto {
  @ApiProperty({ type: Boolean }) publishingEnabled!: boolean;
  @ApiProperty({ type: Boolean }) localDryRunEnabled!: boolean;
  @ApiProperty({ type: Boolean }) youtubeEnabled!: boolean;
  @ApiProperty({ type: Boolean }) tiktokEnabled!: boolean;
}

export class CreatePublicationChannelDto {
  @ApiProperty({ enum: platforms })
  @IsIn(platforms)
  platform!: (typeof platforms)[number];
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  @Matches(/\S/)
  displayName!: string;
  @ApiProperty({ minLength: 1, maxLength: 255 })
  @IsString()
  @Length(1, 255)
  @Matches(/\S/)
  externalChannelRef!: string;
  @ApiProperty({ example: "Asia/Novosibirsk" })
  @IsString()
  @Length(1, 120)
  timezone!: string;
}

export class CreatePublicationIntentDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  channelId!: string;
  @ApiPropertyOptional({ enum: contentKinds, default: "EDITORIAL_EXPORT" })
  @IsOptional()
  @IsIn(contentKinds)
  contentKind?: (typeof contentKinds)[number];
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  approvalId?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  exportResultId?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  verticalApprovalId?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  verticalResultId?: string;
  @ApiProperty({ enum: platforms })
  @IsIn(platforms)
  platform!: (typeof platforms)[number];
  @ApiProperty({ type: String, format: "date-time" })
  @IsISO8601({ strict: true })
  scheduledAt!: string;
  @ApiProperty({ example: "Asia/Novosibirsk" })
  @IsString()
  @Length(1, 120)
  timezone!: string;
  @ApiProperty({ type: Object }) @IsObject() metadataSnapshot!: Record<
    string,
    unknown
  >;
}

export class PublicationListQueryDto {
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  cursor?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  channelId?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class PublicationChannelResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ enum: platforms }) platform!: string;
  @ApiProperty({ type: String }) displayName!: string;
  @ApiProperty({ type: String }) externalChannelRef!: string;
  @ApiProperty({ type: String }) timezone!: string;
  @ApiProperty({ enum: ["ENABLED", "REVOKED"] }) state!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class PublicationIntentResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) channelId!: string;
  @ApiProperty({ enum: contentKinds }) contentKind!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) approvalId!:
    string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  exportIntentId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  exportResultId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  verticalApprovalId!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  verticalResultId!: string | null;
  @ApiProperty({ enum: platforms }) platform!: string;
  @ApiProperty({ type: String, format: "date-time" }) scheduledAt!: string;
  @ApiProperty({ type: String }) timezone!: string;
  @ApiProperty({ type: Object }) metadataSnapshot!: Record<string, unknown>;
  @ApiProperty({
    enum: [
      "SCHEDULED",
      "QUEUED",
      "PROCESSING",
      "UNKNOWN_REMOTE_STATE",
      "DRY_RUN_READY",
      "PUBLISHED",
      "FAILED_FINAL",
      "CANCELED",
    ],
  })
  state!: string;
  @ApiProperty({ type: "integer", minimum: 0 }) attemptCount!: number;
  @ApiProperty({ type: "integer", minimum: 0 }) retryBudget!: number;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  nextAttemptAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) remotePublicationId!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) remoteStatus!: string | null;
  @ApiProperty({
    type: "object",
    nullable: true,
    properties: {
      code: { type: "string" },
      message: { type: "string" },
    },
  })
  failure!: { code: string; message: string } | null;
  @ApiProperty({
    type: "object",
    nullable: true,
    properties: {
      viewCount: { type: "string", pattern: "^[0-9]+$" },
      likeCount: { type: "string", nullable: true, pattern: "^[0-9]+$" },
      commentCount: {
        type: "string",
        nullable: true,
        pattern: "^[0-9]+$",
      },
      shareCount: { type: "string", nullable: true, pattern: "^[0-9]+$" },
      observedAt: { type: "string", format: "date-time" },
    },
  })
  latestMetrics!: {
    viewCount: string;
    likeCount: string | null;
    commentCount: string | null;
    shareCount: string | null;
    observedAt: string;
  } | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class PublicationIntentListResponseDto {
  @ApiProperty({ type: [PublicationIntentResponseDto] })
  items!: PublicationIntentResponseDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true }) nextCursor!:
    string | null;
}

export class ConfirmPublicationRemoteAbsentDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  @Equals(true)
  remoteAbsenceConfirmed!: true;
}

export class TikTokCreatorInfoResponseDto {
  @ApiProperty({ type: String }) creatorAvatarUrl!: string;
  @ApiProperty({ type: String }) creatorNickname!: string;
  @ApiProperty({ type: String }) creatorUsername!: string;
  @ApiProperty({ type: [String] }) privacyLevelOptions!: string[];
  @ApiProperty({ type: Boolean }) commentDisabled!: boolean;
  @ApiProperty({ type: Boolean }) duetDisabled!: boolean;
  @ApiProperty({ type: Boolean }) stitchDisabled!: boolean;
  @ApiProperty({ type: Number }) maxVideoPostDurationSec!: number;
  @ApiProperty({ type: String, format: "date-time" }) fetchedAt!: string;
}
