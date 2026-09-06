import { ApiProperty } from "@nestjs/swagger";
import { IsEmpty, IsIn, IsOptional } from "class-validator";
import {
  MONTAGE_KINDS,
  type MontageKind,
  type MontageAsset,
} from "../domain/montage-asset.js";

export class MontageUploadDto {
  @ApiProperty({ enum: MONTAGE_KINDS }) @IsIn(MONTAGE_KINDS) kind!: MontageKind;
  @ApiProperty({
    type: "string",
    format: "binary",
    description:
      "MP4 ≤256 MiB: 1–180000 ms, one H.264 video, ≤1 AAC audio, ≤3840×2160/60 fps. BANNER: static JPEG/PNG/WebP ≤10 MiB/40M pixels.",
  })
  @IsOptional()
  @IsEmpty()
  file!: unknown;
}
export class MontageFailureDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
  @ApiProperty({ type: Boolean }) retryable!: boolean;
}
export class MontageProbeDto {
  @ApiProperty({
    enum: ["QUEUED", "PROCESSING", "RETRY_WAIT", "READY", "FAILED_FINAL"],
  })
  state!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: Number }) attempt!: number;
  @ApiProperty({ type: Number }) retryBudget!: number;
  @ApiProperty({ type: () => MontageFailureDto, nullable: true })
  failure!: MontageFailureDto | null;
}
export class MontageAssetDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) projectId!: string;
  @ApiProperty({ type: String, format: "uuid" }) sourceId!: string;
  @ApiProperty({ type: Number }) sourceVersion!: number;
  @ApiProperty({ enum: MONTAGE_KINDS }) kind!: MontageKind;
  @ApiProperty({
    enum: ["UPLOADING", "PROBE_PENDING", "READY", "FAILED_FINAL"],
  })
  status!: string;
  @ApiProperty({ type: Number }) revision!: number;
  @ApiProperty({ type: String }) originalFilename!: string;
  @ApiProperty({ enum: ["video/mp4", "image/jpeg", "image/png", "image/webp"] })
  contentType!: string;
  @ApiProperty({ type: String, pattern: "^[0-9]+$" }) sizeBytes!: string;
  @ApiProperty({ type: String, pattern: "^[a-f0-9]{64}$" }) sha256!: string;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({ type: Number, nullable: true }) durationMs!: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) hasAudio!: boolean | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) probeJobId!:
    string | null;
  @ApiProperty({ type: () => MontageProbeDto, nullable: true })
  probe!: MontageProbeDto | null;
  @ApiProperty({ type: () => MontageFailureDto, nullable: true })
  failure!: MontageFailureDto | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}
export class MontageAssetListDto {
  @ApiProperty({ type: [MontageAssetDto] }) items!: MontageAssetDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export function montageResponse(asset: MontageAsset): MontageAssetDto {
  const job = asset.probeJob;
  return {
    id: asset.id,
    projectId: asset.projectId,
    sourceId: asset.sourceId,
    sourceVersion: asset.sourceVersion,
    kind: asset.kind,
    status: asset.status,
    revision: asset.revision,
    originalFilename: asset.originalFilename,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes.toString(),
    sha256: asset.sha256,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    hasAudio: asset.hasAudio,
    probeJobId: job?.id ?? null,
    probe: job
      ? {
          state: job.state,
          revision: job.revision,
          attempt: job.attemptCount,
          retryBudget: job.retryBudget,
          failure:
            job.failureCode && job.failureMessage
              ? {
                  code: job.failureCode,
                  message: job.failureMessage,
                  retryable: job.failureRetryable ?? false,
                }
              : null,
        }
      : null,
    failure:
      asset.failureCode && asset.failureMessage
        ? {
            code: asset.failureCode,
            message: asset.failureMessage,
            retryable: false,
          }
        : null,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}
