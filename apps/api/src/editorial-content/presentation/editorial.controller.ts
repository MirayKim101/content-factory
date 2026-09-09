import type { ServerResponse } from "node:http";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { ErrorResponseDto } from "../../projects/presentation/project.dto.js";
import { TempUploadLifecycleInterceptor } from "../../projects/presentation/temp-upload-lifecycle.interceptor.js";
import { SourceAuthorizationRequiredError } from "../../projects/domain/source-authorization.js";
import { CreateProcessingTemplate } from "../application/create-processing-template.js";
import {
  GetEditorialAsset,
  GetEditorialPackage,
  ListEditorialAssets,
  ListEditorialPackages,
} from "../application/editorial-queries.js";
import {
  EditorialAssetNotFoundError,
  EditorialAssetProjectMismatchError,
  EditorialCutArtifactInvalidError,
  EditorialCutNotReadyError,
  EditorialIdempotencyConflictError,
  EditorialProjectNotFoundError,
  EditorialRevisionConflictError,
  ProcessingTemplateRevisionNotFoundError,
} from "../application/editorial-repository.port.js";
import {
  EDITORIAL_STORAGE,
  type EditorialStorage,
} from "../application/editorial-storage.port.js";
import { ListProcessingTemplates } from "../application/list-processing-templates.js";
import { SaveEditorialPackage } from "../application/save-editorial-package.js";
import {
  EditorialUploadError,
  UploadThumbnail,
} from "../application/upload-thumbnail.js";
import { ThumbnailValidationError } from "../domain/editorial.js";
import {
  CreateProcessingTemplateDto,
  EditorialAssetListResponseDto,
  EditorialAssetResponseDto,
  EditorialPackageListResponseDto,
  EditorialPackageResponseDto,
  ProcessingTemplateListResponseDto,
  ProcessingTemplateRevisionResponseDto,
  SaveEditorialPackageDto,
  ThumbnailUploadDto,
} from "./editorial.dto.js";
import {
  toEditorialAssetResponse,
  toEditorialPackageResponse,
  toProcessingTemplateResponse,
} from "./editorial-response.js";
import { editorialUploadOptions } from "./editorial-upload-options.js";

@ApiTags("editorial-content")
@Controller("api/v1")
export class EditorialController {
  constructor(
    @Inject(CreateProcessingTemplate)
    private readonly createTemplate: CreateProcessingTemplate,
    @Inject(ListProcessingTemplates)
    private readonly listTemplates: ListProcessingTemplates,
    @Inject(UploadThumbnail)
    private readonly uploadThumbnail: UploadThumbnail,
    @Inject(ListEditorialAssets)
    private readonly listAssets: ListEditorialAssets,
    @Inject(GetEditorialAsset)
    private readonly getAsset: GetEditorialAsset,
    @Inject(SaveEditorialPackage)
    private readonly savePackage: SaveEditorialPackage,
    @Inject(GetEditorialPackage)
    private readonly getPackage: GetEditorialPackage,
    @Inject(ListEditorialPackages)
    private readonly listPackages: ListEditorialPackages,
    @Inject(EDITORIAL_STORAGE) private readonly storage: EditorialStorage,
  ) {}

  @Post("processing-templates")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create immutable processing template revision 1" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreateProcessingTemplateDto })
  @ApiCreatedResponse({ type: ProcessingTemplateRevisionResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async createProcessingTemplate(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateProcessingTemplateDto,
  ): Promise<ProcessingTemplateRevisionResponseDto> {
    try {
      return toProcessingTemplateResponse(
        await this.createTemplate.execute({
          name: body.name,
          idempotencyKey: requireIdempotencyKey(idempotencyKey),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("processing-templates")
  @ApiOkResponse({ type: ProcessingTemplateListResponseDto })
  async processingTemplates(): Promise<ProcessingTemplateListResponseDto> {
    return {
      items: (await this.listTemplates.execute()).map(
        toProcessingTemplateResponse,
      ),
    };
  }

  @Post("projects/:projectId/editorial-assets/thumbnails")
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    TempUploadLifecycleInterceptor,
    FileInterceptor("file", editorialUploadOptions),
  )
  @ApiOperation({ summary: "Upload one private project thumbnail" })
  @ApiConsumes("multipart/form-data")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
  @ApiBody({ type: ThumbnailUploadDto })
  @ApiCreatedResponse({ type: EditorialAssetResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto })
  @ApiResponse({ status: 413, type: ErrorResponseDto })
  @ApiResponse({ status: 415, type: ErrorResponseDto })
  @ApiResponse({ status: 422, type: ErrorResponseDto })
  @ApiResponse({ status: 500, type: ErrorResponseDto })
  @ApiResponse({ status: 503, type: ErrorResponseDto })
  async createThumbnail(
    @Param("projectId", new ParseUUIDPipe({ version: "4" }))
    projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<EditorialAssetResponseDto> {
    if (!file) {
      throw new BadRequestException({
        code: "THUMBNAIL_REQUIRED",
        message: "A thumbnail file is required.",
      });
    }
    try {
      return toEditorialAssetResponse(
        await this.uploadThumbnail.execute({
          projectId,
          idempotencyKey: requireIdempotencyKey(idempotencyKey),
          originalFilename: normalizeFilename(file.originalname),
          declaredContentType: file.mimetype,
          filePath: file.path,
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("projects/:projectId/editorial-assets/thumbnails")
  @ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ type: EditorialAssetListResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  async thumbnails(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
  ): Promise<EditorialAssetListResponseDto> {
    try {
      return {
        items: (await this.listAssets.execute(projectId)).map(
          toEditorialAssetResponse,
        ),
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("projects/:projectId/editorial-assets/thumbnails/:assetId/content")
  @ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "assetId", schema: { type: "string", format: "uuid" } })
  @ApiProduces("image/jpeg", "image/png", "image/webp")
  @ApiOkResponse({
    description:
      "Private thumbnail bytes. Storage object keys are never exposed.",
    content: {
      "image/jpeg": { schema: { type: "string", format: "binary" } },
      "image/png": { schema: { type: "string", format: "binary" } },
      "image/webp": { schema: { type: "string", format: "binary" } },
    },
  })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  async thumbnailContent(
    @Param("projectId", new ParseUUIDPipe({ version: "4" }))
    projectId: string,
    @Param("assetId", new ParseUUIDPipe({ version: "4" })) assetId: string,
    @Res() response: ServerResponse,
  ): Promise<void> {
    let found;
    try {
      found = await this.getAsset.execute(projectId, assetId);
    } catch (error) {
      this.rethrow(error);
    }
    if (!found) {
      throw new NotFoundException({
        code: "THUMBNAIL_NOT_FOUND",
        message: "Thumbnail was not found in this project.",
      });
    }
    const stored = await this.storage.readObject(found.objectKey);
    if (!stored) {
      throw new NotFoundException({
        code: "THUMBNAIL_OBJECT_NOT_FOUND",
        message: "Thumbnail content was not found.",
      });
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", found.asset.contentType);
    response.setHeader("Content-Length", String(stored.contentLength));
    response.setHeader("Cache-Control", "private, no-store");
    if (stored.etag) response.setHeader("ETag", stored.etag);
    stored.body.on("error", () => response.destroy());
    stored.body.pipe(response);
  }

  @Put("pipeline-jobs/:jobId/editorial-package")
  @ApiOperation({ summary: "Save one immutable editorial package revision" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiParam({ name: "jobId", schema: { type: "string", format: "uuid" } })
  @ApiBody({ type: SaveEditorialPackageDto })
  @ApiOkResponse({ type: EditorialPackageResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({ status: 403, type: ErrorResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto })
  @ApiResponse({ status: 422, type: ErrorResponseDto })
  async putPackage(
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: SaveEditorialPackageDto,
  ): Promise<EditorialPackageResponseDto> {
    try {
      return toEditorialPackageResponse(
        await this.savePackage.execute({
          pipelineJobId: jobId,
          idempotencyKey: requireIdempotencyKey(idempotencyKey),
          ...body,
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("pipeline-jobs/:jobId/editorial-package")
  @ApiParam({ name: "jobId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ type: EditorialPackageResponseDto })
  @ApiResponse({ status: 403, type: ErrorResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto })
  async package(
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
  ): Promise<EditorialPackageResponseDto> {
    try {
      const value = await this.getPackage.execute(jobId);
      if (!value) {
        throw new NotFoundException({
          code: "EDITORIAL_PACKAGE_NOT_FOUND",
          message: "Editorial package was not found.",
        });
      }
      return toEditorialPackageResponse(value);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("projects/:projectId/editorial-packages")
  @ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ type: EditorialPackageListResponseDto })
  @ApiResponse({ status: 403, type: ErrorResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  @ApiResponse({ status: 409, type: ErrorResponseDto })
  async projectPackages(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
  ): Promise<EditorialPackageListResponseDto> {
    try {
      return {
        items: (await this.listPackages.execute(projectId)).map(
          toEditorialPackageResponse,
        ),
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof SourceAuthorizationRequiredError) {
      throw new HttpException(
        {
          code: "SOURCE_AUTHORIZATION_REQUIRED",
          message:
            "Explicit authorization is required for this source version.",
        },
        HttpStatus.FORBIDDEN,
      );
    }
    if (error instanceof EditorialIdempotencyConflictError) {
      throw new ConflictException({
        code: "IDEMPOTENCY_CONFLICT",
        message: "This key belongs to a different editorial request.",
      });
    }
    if (error instanceof EditorialProjectNotFoundError) {
      throw new NotFoundException({
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found.",
      });
    }
    if (error instanceof EditorialCutNotReadyError) {
      throw new ConflictException({
        code: "CUT_RESULT_NOT_READY",
        message: "A READY cut job is required.",
      });
    }
    if (error instanceof EditorialCutArtifactInvalidError) {
      throw new ConflictException({
        code: "CUT_RESULT_LINEAGE_INVALID",
        message: "The ready cut result lineage is invalid.",
      });
    }
    if (error instanceof EditorialRevisionConflictError) {
      throw new ConflictException({
        code: "EDITORIAL_REVISION_CONFLICT",
        message: "The editorial package changed. Refresh before saving.",
      });
    }
    if (error instanceof EditorialAssetProjectMismatchError) {
      throw new ConflictException({
        code: "THUMBNAIL_PROJECT_MISMATCH",
        message: "Thumbnail does not belong to the cut project.",
      });
    }
    if (error instanceof EditorialAssetNotFoundError) {
      throw new NotFoundException({
        code: "THUMBNAIL_NOT_FOUND",
        message: "A ready thumbnail was not found.",
      });
    }
    if (error instanceof ProcessingTemplateRevisionNotFoundError) {
      throw new NotFoundException({
        code: "PROCESSING_TEMPLATE_REVISION_NOT_FOUND",
        message: "Processing template revision was not found.",
      });
    }
    if (error instanceof ThumbnailValidationError) {
      throw new HttpException(
        { code: error.code, message: error.message },
        error.code === "THUMBNAIL_PIXEL_LIMIT_EXCEEDED" ||
          error.code === "THUMBNAIL_CORRUPT"
          ? HttpStatus.UNPROCESSABLE_ENTITY
          : HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
    if (error instanceof EditorialUploadError) {
      throw new HttpException(
        { code: error.code, message: error.message },
        error.httpStatus,
      );
    }
    throw error;
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "A valid Idempotency-Key header is required.",
    });
  }
  return value;
}

function normalizeFilename(filename: string): string {
  return filename.replaceAll("\\", "/").split("/").pop() || "thumbnail";
}
