import { Type } from "class-transformer";
import {
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

export class CreatePublicationChannelDto {
  @ApiProperty({ enum: platforms }) @IsIn(platforms) platform!:
    (typeof platforms)[number];
  @ApiProperty({ minLength: 1, maxLength: 120 }) @IsString() @Length(1, 120) @Matches(/\S/) displayName!: string;
  @ApiProperty({ minLength: 1, maxLength: 255 }) @IsString() @Length(1, 255) @Matches(/\S/) externalChannelRef!: string;
  @ApiProperty({ example: "Asia/Novosibirsk" }) @IsString() @Length(1, 120) timezone!: string;
}

export class CreatePublicationIntentDto {
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID("4") channelId!: string;
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID("4") approvalId!: string;
  @ApiProperty({ type: String, format: "uuid" }) @IsUUID("4") exportResultId!: string;
  @ApiProperty({ enum: platforms }) @IsIn(platforms) platform!:
    (typeof platforms)[number];
  @ApiProperty({ type: String, format: "date-time" }) @IsISO8601({ strict: true }) scheduledAt!: string;
  @ApiProperty({ example: "Asia/Novosibirsk" }) @IsString() @Length(1, 120) timezone!: string;
  @ApiProperty({ type: Object }) @IsObject() metadataSnapshot!: Record<string, unknown>;
}

export class PublicationListQueryDto {
  @ApiPropertyOptional({ type: String, format: "uuid" }) @IsOptional() @IsUUID("4") cursor?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" }) @IsOptional() @IsUUID("4") channelId?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
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
  @ApiProperty({ type: String, format: "uuid" }) approvalId!: string;
  @ApiProperty({ type: String, format: "uuid" }) exportIntentId!: string;
  @ApiProperty({ type: String, format: "uuid" }) exportResultId!: string;
  @ApiProperty({ enum: platforms }) platform!: string;
  @ApiProperty({ type: String, format: "date-time" }) scheduledAt!: string;
  @ApiProperty({ type: String }) timezone!: string;
  @ApiProperty({ type: Object }) metadataSnapshot!: Record<string, unknown>;
  @ApiProperty({ enum: ["SCHEDULED", "QUEUED", "PROCESSING", "UNKNOWN_REMOTE_STATE", "DRY_RUN_READY", "PUBLISHED", "FAILED_FINAL", "CANCELED"] }) state!: string;
  @ApiProperty({ type: "integer", minimum: 0 }) attemptCount!: number;
  @ApiProperty({ type: "integer", minimum: 0 }) retryBudget!: number;
  @ApiProperty({ type: String, nullable: true }) remotePublicationId!: string | null;
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
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class PublicationIntentListResponseDto {
  @ApiProperty({ type: [PublicationIntentResponseDto] }) items!: PublicationIntentResponseDto[];
  @ApiProperty({ type: String, format: "uuid", nullable: true }) nextCursor!: string | null;
}
