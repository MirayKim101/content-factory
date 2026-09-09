import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export class CreatorProfileRevisionInputDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  canonicalDisplayName!: string;

  @ApiProperty({ type: String, format: "uri", maxLength: 2048 })
  @IsString()
  @Length(1, 2048)
  officialUrl!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 35 })
  @IsString()
  @Length(1, 35)
  @Matches(/\S/)
  primaryLanguage!: string;

  @ApiProperty({ type: [String], maxItems: 30 })
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  topics!: string[];

  @ApiProperty({ type: String, maxLength: 5000 })
  @IsString()
  @MaxLength(5000)
  editorialNotes!: string;

  @ApiProperty({ type: [String], maxItems: 30 })
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 500, { each: true })
  restrictions!: string[];
}

export class UpdateCreatorProfileDto extends CreatorProfileRevisionInputDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_646 })
  @IsInt()
  @Min(1)
  @Max(2_147_483_646)
  expectedRevision!: number;
}

export class CreatorReferenceUploadDto {
  @ApiProperty({ type: "string", format: "binary" })
  @Allow()
  file!: unknown;
}

export class UpdateCreatorReferenceAuthorizationDto {
  @ApiProperty({ type: "integer", minimum: 1 })
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @ApiProperty({ enum: ["CLEARED", "REVOKED"] })
  @IsIn(["CLEARED", "REVOKED"])
  decision!: "CLEARED" | "REVOKED";

  @ApiPropertyOptional({ enum: ["creator-likeness-rights-v1"], nullable: true })
  @IsOptional()
  @IsString()
  declarationVersion?: string | null;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  commercialAiImageUseAttested?: boolean;

  @ApiPropertyOptional({ type: String, maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  basis?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  scope?: string | null;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  @IsOptional()
  @IsString()
  expiresAt?: string | null;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  externalProviderTransferAllowed?: boolean;
}

export class SetDefaultCreatorReferenceDto {
  @ApiProperty({ type: "integer", minimum: 1 })
  @IsInt()
  @Min(1)
  expectedProfileRevision!: number;

  @ApiProperty({ enum: ["SET", "CLEAR"] })
  @IsIn(["SET", "CLEAR"])
  action!: "SET" | "CLEAR";

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  assetId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID("4")
  authorizationRevisionId?: string;

  @ApiPropertyOptional({ type: "integer", minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  authorizationRevision?: number;
}

export class SourceEditorialContextInputDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  creatorProfileId!: string;

  @ApiProperty({ type: "integer", minimum: 1 })
  @IsInt()
  @Min(1)
  creatorProfileRevision!: number;

  @ApiProperty({ type: String, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  sourceTitle!: string;
  @ApiProperty({ type: String, maxLength: 300 })
  @IsString()
  @Length(1, 300)
  gameOrTopic!: string;
  @ApiProperty({ type: String, maxLength: 1000 })
  @IsString()
  @Length(1, 1000)
  audience!: string;
  @ApiProperty({ type: String, maxLength: 1000 })
  @IsString()
  @Length(1, 1000)
  editorialGoal!: string;
  @ApiProperty({ type: String, maxLength: 35 })
  @IsString()
  @Length(1, 35)
  language!: string;
  @ApiProperty({ type: String, maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  defaultCta!: string;
  @ApiProperty({ type: [String], maxItems: 30 })
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 500, { each: true })
  restrictions!: string[];
  @ApiProperty({ type: String, maxLength: 5000 })
  @IsString()
  @MaxLength(5000)
  operatorNotes!: string;
}

export class PutSourceEditorialContextDto extends SourceEditorialContextInputDto {
  @ApiProperty({ type: "integer", minimum: 0, maximum: 2_147_483_646 })
  @IsInt()
  @Min(0)
  @Max(2_147_483_646)
  expectedRevision!: number;
}

export class CutEditorialPromptInputDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID("4")
  sourceContextId!: string;
  @ApiProperty({ type: "integer", minimum: 1 })
  @IsInt()
  @Min(1)
  sourceContextRevision!: number;
  @ApiProperty({ type: String, maxLength: 5000 })
  @IsString()
  @Length(1, 5000)
  whatHappens!: string;
  @ApiProperty({ type: String, maxLength: 1000 })
  @IsString()
  @Length(1, 1000)
  desiredAngle!: string;
  @ApiProperty({ type: String, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  tone!: string;
  @ApiProperty({ type: String, maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  cta!: string;
  @ApiProperty({ type: [String], maxItems: 30 })
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 500, { each: true })
  restrictions!: string[];
}

export class PutCutEditorialPromptDto extends CutEditorialPromptInputDto {
  @ApiProperty({ type: "integer", minimum: 0, maximum: 2_147_483_646 })
  @IsInt()
  @Min(0)
  @Max(2_147_483_646)
  expectedRevision!: number;
}

export class LikenessUsabilityResponseDto {
  @ApiProperty({ type: Boolean }) usable!: boolean;
  @ApiProperty({ type: String, nullable: true }) blocker!: string | null;
  @ApiProperty({ type: Boolean }) externalProviderTransferAllowed!: boolean;
}

export class CreatorDefaultReferenceResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) assetId!: string;
  @ApiProperty({ type: String, format: "uuid" })
  authorizationRevisionId!: string;
  @ApiProperty({ type: "integer" }) authorizationRevision!: number;
  @ApiProperty({ enum: ["NOT_REVIEWED", "CLEARED", "REVOKED"] })
  authorizationStatus!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  expiresAt!: string | null;
  @ApiProperty({ type: Boolean }) externalProviderTransferAllowed!: boolean;
}

export class CreatorProfileRevisionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) profileId!: string;
  @ApiProperty({ type: "integer" }) revision!: number;
  @ApiProperty({ type: CreatorProfileRevisionInputDto })
  editableRevision!: CreatorProfileRevisionInputDto;
  @ApiProperty({
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      canonicalizationVersion: { type: "string" },
      canonicalUrl: { type: "string", format: "uri" },
    },
  })
  officialUrlIdentity!: {
    id: string;
    canonicalizationVersion: string;
    canonicalUrl: string;
  };
  @ApiProperty({ enum: ["NO_REALISTIC_LIKENESS", "CLEARED_REFERENCE_ONLY"] })
  likenessPolicy!: string;
  @ApiProperty({ type: CreatorDefaultReferenceResponseDto, nullable: true })
  defaultReference!: CreatorDefaultReferenceResponseDto | null;
  @ApiProperty({ enum: ["CURRENT", "STALE"] }) status!: string;
  @ApiProperty({ type: LikenessUsabilityResponseDto })
  likenessUsability!: LikenessUsabilityResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class CreatorProfileDetailResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer" }) currentRevision!: number;
  @ApiProperty({ type: CreatorProfileRevisionResponseDto })
  revision!: CreatorProfileRevisionResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class CreatorProfileSummaryResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer" }) currentRevision!: number;
  @ApiProperty({ type: String }) canonicalDisplayName!: string;
  @ApiProperty({ type: String, format: "uri" }) officialUrl!: string;
  @ApiProperty({ type: String }) primaryLanguage!: string;
  @ApiProperty({ type: [String] }) topics!: string[];
  @ApiProperty({ enum: ["NO_REALISTIC_LIKENESS", "CLEARED_REFERENCE_ONLY"] })
  likenessPolicy!: string;
  @ApiProperty({ type: Boolean }) likenessAllowed!: boolean;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class CreatorReferenceAuthorizationResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer" }) revision!: number;
  @ApiProperty({ enum: ["NOT_REVIEWED", "CLEARED", "REVOKED"] })
  status!: string;
  @ApiProperty({ type: String, nullable: true }) declarationVersion!:
    string | null;
  @ApiProperty({ type: Boolean }) commercialAiImageUseAttested!: boolean;
  @ApiProperty({ type: String, nullable: true }) basis!: string | null;
  @ApiProperty({ type: String, nullable: true }) scope!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  expiresAt!: string | null;
  @ApiProperty({ type: Boolean }) externalProviderTransferAllowed!: boolean;
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  decidedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class CreatorReferenceAssetResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) creatorProfileId!: string;
  @ApiProperty({ enum: ["PENDING", "READY", "FAILED_FINAL"] }) status!: string;
  @ApiProperty({ type: String }) originalFilename!: string;
  @ApiProperty({ enum: IMAGE_TYPES }) contentType!: string;
  @ApiProperty({ type: String, pattern: "^[0-9]+$" }) sizeBytes!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: "integer" }) width!: number;
  @ApiProperty({ type: "integer" }) height!: number;
  @ApiProperty({ type: CreatorReferenceAuthorizationResponseDto })
  currentAuthorization!: CreatorReferenceAuthorizationResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class AuthorizationDetailResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) assetId!: string;
  @ApiProperty({ type: String, format: "uuid" }) creatorProfileId!: string;
  @ApiProperty({ type: "integer" }) currentRevision!: number;
  @ApiProperty({ type: CreatorReferenceAuthorizationResponseDto })
  current!: CreatorReferenceAuthorizationResponseDto;
  @ApiProperty({ type: [CreatorReferenceAuthorizationResponseDto] })
  history!: CreatorReferenceAuthorizationResponseDto[];
}

export class SourceEditorialContextRevisionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) contextId!: string;
  @ApiProperty({ type: "integer" }) revision!: number;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: "integer" }) sourceVersion!: number;
  @ApiProperty({ type: SourceEditorialContextInputDto })
  editableRevision!: SourceEditorialContextInputDto;
  @ApiProperty({ type: String, format: "uuid" })
  creatorProfileRevisionId!: string;
  @ApiProperty({ enum: ["CURRENT", "STALE"] }) status!: string;
  @ApiProperty({ type: [String] }) blockers!: string[];
  @ApiProperty({ type: LikenessUsabilityResponseDto })
  likenessUsability!: LikenessUsabilityResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class SourceEditorialContextDetailResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer" }) currentRevision!: number;
  @ApiProperty({ type: SourceEditorialContextRevisionResponseDto })
  revision!: SourceEditorialContextRevisionResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class CutEditorialPromptRevisionResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) promptId!: string;
  @ApiProperty({ type: "integer" }) revision!: number;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: "integer" }) sourceVersion!: number;
  @ApiProperty({ type: String, format: "uuid" }) cutPipelineJobId!: string;
  @ApiProperty({
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      sha256: { type: "string" },
      sizeBytes: { type: "string" },
    },
  })
  cutResultArtifact!: { id: string; sha256: string; sizeBytes: string };
  @ApiProperty({ type: CutEditorialPromptInputDto })
  editableRevision!: CutEditorialPromptInputDto;
  @ApiProperty({ type: String, format: "uuid" })
  sourceContextRevisionId!: string;
  @ApiProperty({ enum: ["CURRENT", "STALE"] }) status!: string;
  @ApiProperty({ type: [String] }) blockers!: string[];
  @ApiProperty({ type: LikenessUsabilityResponseDto })
  likenessUsability!: LikenessUsabilityResponseDto;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" })
  contextPolicyFingerprint!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class CutEditorialPromptDetailResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer" }) currentRevision!: number;
  @ApiProperty({ type: CutEditorialPromptRevisionResponseDto })
  revision!: CutEditorialPromptRevisionResponseDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class CreatorProfileListResponseDto {
  @ApiProperty({ type: [CreatorProfileSummaryResponseDto] })
  items!: CreatorProfileSummaryResponseDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class CreatorProfileRevisionListResponseDto {
  @ApiProperty({ type: [CreatorProfileRevisionResponseDto] })
  items!: CreatorProfileRevisionResponseDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class CreatorReferenceAssetListResponseDto {
  @ApiProperty({ type: [CreatorReferenceAssetResponseDto] })
  items!: CreatorReferenceAssetResponseDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class SourceEditorialContextRevisionListResponseDto {
  @ApiProperty({ type: [SourceEditorialContextRevisionResponseDto] })
  items!: SourceEditorialContextRevisionResponseDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class CutEditorialPromptRevisionListResponseDto {
  @ApiProperty({ type: [CutEditorialPromptRevisionResponseDto] })
  items!: CutEditorialPromptRevisionResponseDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
