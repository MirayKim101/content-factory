import type { ServerResponse } from "node:http";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  OBJECT_STORAGE,
  ObjectRangeNotSatisfiableError,
  type ObjectStorage,
} from "../../projects/application/object-storage.port.js";
import { SecureDiskStorage } from "../../projects/presentation/secure-disk-storage.js";
import { TempUploadLifecycleInterceptor } from "../../projects/presentation/temp-upload-lifecycle.interceptor.js";
import { ErrorResponseDto } from "../../projects/presentation/project.dto.js";
import {
  MONTAGE_REPOSITORY,
  type MontageRepository,
} from "../application/montage-repository.port.js";
import { UploadMontageAsset } from "../application/upload-montage-asset.js";
import {
  MONTAGE_KINDS,
  MONTAGE_MAX_BYTES,
  MontageError,
  type MontageKind,
} from "../domain/montage-asset.js";
import { ThumbnailValidationError } from "../domain/editorial.js";
import {
  MontageAssetDto,
  MontageAssetListDto,
  MontageUploadDto,
  montageResponse,
} from "./montage.dto.js";
import { isUuidV4 } from "./montage-identifier.js";
import { normalizeMultipartFilename } from "../../http/multipart-filename.js";
import { MontageUploadAdmissionInterceptor } from "./montage-upload-admission.interceptor.js";

@ApiTags("montage-assets")
@ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@Controller("api/v1/projects/:projectId/montage-assets")
export class MontageController {
  constructor(
    @Inject(UploadMontageAsset) private readonly upload: UploadMontageAsset,
    @Inject(MONTAGE_REPOSITORY) private readonly repository: MontageRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(
    MontageUploadAdmissionInterceptor,
    TempUploadLifecycleInterceptor,
    FileInterceptor("file", {
      storage: new SecureDiskStorage(),
      limits: {
        fileSize: MONTAGE_MAX_BYTES,
        files: 1,
        fields: 1,
        parts: 3,
        fieldSize: 100,
      },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: MontageUploadDto })
  @ApiResponse({ status: 202, type: MontageAssetDto })
  @ApiResponse({ status: 413, type: ErrorResponseDto })
  @ApiResponse({ status: 415, type: ErrorResponseDto })
  @ApiResponse({ status: 422, type: ErrorResponseDto })
  @ApiResponse({ status: 429, type: ErrorResponseDto })
  @ApiResponse({ status: 503, type: ErrorResponseDto })
  async create(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Headers("idempotency-key") key: string,
    @Body() body: MontageUploadDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<MontageAssetDto> {
    try {
      if (!file)
        throw new MontageError(
          "MONTAGE_FILE_REQUIRED",
          "A montage file is required.",
          400,
        );
      return montageResponse(
        await this.upload.execute({
          projectId,
          kind: body.kind,
          idempotencyKey: key,
          originalFilename: normalizeMultipartFilename(file.originalname),
          declaredContentType: file.mimetype,
          filePath: file.path,
        }),
      );
    } catch (error) {
      rethrow(error);
    }
  }

  @Get()
  @ApiQuery({ name: "kind", enum: MONTAGE_KINDS, required: false })
  @ApiQuery({ name: "cursor", type: String, required: false })
  @ApiQuery({
    name: "limit",
    type: Number,
    required: false,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({ type: MontageAssetListDto })
  async list(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query("kind") kind?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ): Promise<MontageAssetListDto> {
    try {
      const limit = rawLimit === undefined ? 25 : Number(rawLimit);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (kind !== undefined && !MONTAGE_KINDS.includes(kind as MontageKind)) ||
        (cursor !== undefined && !isUuidV4(cursor))
      )
        throw new MontageError(
          "MONTAGE_QUERY_INVALID",
          "Invalid montage list filters.",
          400,
        );
      const rows = await this.repository.list(
        projectId,
        kind as MontageKind | undefined,
        cursor,
        limit + 1,
      );
      return {
        items: rows.slice(0, limit).map(montageResponse),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    } catch (error) {
      rethrow(error);
    }
  }

  @Get(":assetId")
  @ApiParam({ name: "assetId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ type: MontageAssetDto })
  async get(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Param("assetId", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<MontageAssetDto> {
    try {
      const asset = await this.repository.get(projectId, id);
      if (!asset)
        throw new MontageError(
          "MONTAGE_NOT_FOUND",
          "Montage asset not found in this project.",
          404,
        );
      return montageResponse(asset);
    } catch (error) {
      rethrow(error);
    }
  }

  @Get(":assetId/content")
  @ApiParam({ name: "assetId", schema: { type: "string", format: "uuid" } })
  @ApiHeader({ name: "Range", required: false })
  @ApiResponse({
    status: 200,
    content: {
      "video/mp4": { schema: { type: "string", format: "binary" } },
      "image/png": { schema: { type: "string", format: "binary" } },
      "image/jpeg": { schema: { type: "string", format: "binary" } },
      "image/webp": { schema: { type: "string", format: "binary" } },
    },
  })
  @ApiResponse({
    status: 206,
    content: { "video/mp4": { schema: { type: "string", format: "binary" } } },
  })
  @ApiResponse({ status: 416, type: ErrorResponseDto })
  async content(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Param("assetId", new ParseUUIDPipe({ version: "4" })) id: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    try {
      const asset = await this.repository.get(projectId, id);
      if (!asset)
        throw new MontageError(
          "MONTAGE_NOT_FOUND",
          "Montage asset not found in this project.",
          404,
        );
      if (asset.status !== "READY")
        throw new MontageError(
          "MONTAGE_NOT_READY",
          "Montage asset has not passed validation.",
          409,
        );
      if (
        range &&
        (!/^bytes=(\d*)-(\d*)$/.test(range) ||
          range === "bytes=-" ||
          range.length > 100)
      )
        throw new MontageError(
          "RANGE_INVALID",
          "Only one byte range is supported.",
          400,
        );
      if (!this.storage.readObject)
        throw new Error("STORAGE_STREAM_UNAVAILABLE");
      let stored;
      try {
        stored = await this.storage.readObject(asset.objectKey, range);
      } catch (error) {
        if (error instanceof ObjectRangeNotSatisfiableError) {
          response.setHeader("Content-Range", `bytes */${asset.sizeBytes}`);
          throw new MontageError(
            "RANGE_NOT_SATISFIABLE",
            "Requested range is not satisfiable.",
            416,
          );
        }
        throw error;
      }
      if (!stored)
        throw new MontageError(
          "MONTAGE_CONTENT_MISSING",
          "Stored montage content is missing.",
          404,
        );
      response.statusCode = stored.contentRange ? 206 : 200;
      response.setHeader("Content-Type", asset.contentType);
      response.setHeader("Content-Length", String(stored.contentLength));
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (stored.contentRange)
        response.setHeader("Content-Range", stored.contentRange);
      stored.body.on("error", () => response.destroy());
      response.once("close", () => stored.body.destroy());
      stored.body.pipe(response);
    } catch (error) {
      rethrow(error);
    }
  }
}

function rethrow(error: unknown): never {
  if (error instanceof MontageError)
    throw new HttpException(
      { code: error.code, message: error.message },
      error.httpStatus,
    );
  if (error instanceof ThumbnailValidationError)
    throw new HttpException(
      {
        code: error.code.replace("THUMBNAIL", "MONTAGE"),
        message: error.message,
      },
      422,
    );
  throw error;
}
