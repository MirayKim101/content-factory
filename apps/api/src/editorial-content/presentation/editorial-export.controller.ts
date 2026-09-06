import type { ServerResponse } from "node:http";

import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
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
  Query,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from "@nestjs/swagger";

import {
  OBJECT_STORAGE,
  ObjectRangeNotSatisfiableError,
  type ObjectStorage,
} from "../../projects/application/object-storage.port.js";
import { ErrorResponseDto } from "../../projects/presentation/project.dto.js";
import { CreateEditorialExport } from "../application/create-editorial-export.js";
import {
  GetEditorialExport,
  GetEditorialExportContent,
  ListEditorialExports,
} from "../application/editorial-export-queries.js";
import {
  EditorialExportApprovalStaleError,
  EditorialExportAuthorizationError,
  EditorialExportCursorInvalidError,
  EditorialExportIdempotencyConflictError,
  EditorialExportLineageInvalidError,
  EditorialExportNotFoundError,
  EditorialExportResultNotReadyError,
  EditorialExportUnavailableError,
} from "../domain/editorial-export.js";
import {
  EditorialExportListQueryDto,
  EditorialExportListResponseDto,
  EditorialExportResponseDto,
} from "./editorial-export.dto.js";
import { editorialExportResponse } from "./editorial-export-response.js";

@ApiTags("editorial-content")
@ApiExtraModels(ErrorResponseDto)
@Controller("api/v1")
export class EditorialExportController {
  constructor(
    @Inject(CreateEditorialExport)
    private readonly createExport: CreateEditorialExport,
    @Inject(GetEditorialExport) private readonly getExport: GetEditorialExport,
    @Inject(ListEditorialExports)
    private readonly listExports: ListEditorialExports,
    @Inject(GetEditorialExportContent)
    private readonly getContent: GetEditorialExportContent,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Post("editorial-approvals/:approvalId/exports")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Create one exact-approval background export package",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 202, type: EditorialExportResponseDto })
  @ApiResponse({ status: 400 })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409 })
  @ApiResponse({ status: 503 })
  async create(
    @Param("approvalId", new ParseUUIDPipe({ version: "4" }))
    approvalId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ): Promise<EditorialExportResponseDto> {
    try {
      return editorialExportResponse(
        await this.createExport.execute({
          approvalId,
          idempotencyKey: requireIdempotencyKey(idempotencyKey),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("editorial-exports/:exportId")
  @ApiOkResponse({ type: EditorialExportResponseDto })
  async one(
    @Param("exportId", new ParseUUIDPipe({ version: "4" })) exportId: string,
  ): Promise<EditorialExportResponseDto> {
    try {
      const value = await this.getExport.execute(exportId);
      if (!value) throw new EditorialExportNotFoundError();
      return editorialExportResponse(value);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("projects/:projectId/editorial-exports")
  @ApiOkResponse({ type: EditorialExportListResponseDto })
  async project(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query() query: EditorialExportListQueryDto,
  ): Promise<EditorialExportListResponseDto> {
    try {
      const values = await this.listExports.execute({
        projectId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit + 1,
      });
      const hasMore = values.length > query.limit;
      const page = values.slice(0, query.limit);
      return {
        items: page.map(editorialExportResponse),
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("editorial-exports/:exportId/content")
  @ApiProduces("application/zip")
  @ApiHeader({
    name: "Range",
    required: false,
    description: "One RFC 9110 byte range.",
  })
  @ApiOkResponse({
    description: "Ready private editorial ZIP64 package.",
    content: {
      "application/zip": { schema: { type: "string", format: "binary" } },
    },
  })
  @ApiResponse({
    status: 206,
    content: {
      "application/zip": { schema: { type: "string", format: "binary" } },
    },
  })
  @ApiResponse({
    status: 416,
    content: {
      "application/json": { schema: { $ref: getSchemaPath(ErrorResponseDto) } },
    },
  })
  async content(
    @Param("exportId", new ParseUUIDPipe({ version: "4" })) exportId: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    let object;
    try {
      object = await this.getContent.execute(exportId);
    } catch (error) {
      this.rethrow(error);
    }
    if (range) {
      const state = byteRangeState(range, object.sizeBytes);
      if (state === "invalid")
        throw new BadRequestException({
          code: "RANGE_INVALID",
          message: "Only one byte range is supported.",
        });
      if (state === "unsatisfiable")
        this.rangeFailure(object.sizeBytes, response);
    }
    if (!this.storage.readObject)
      throw new Error("MEDIA_STORAGE_STREAMING_UNAVAILABLE");
    let stored;
    try {
      stored = await this.storage.readObject(object.objectKey, range);
    } catch (error) {
      if (error instanceof ObjectRangeNotSatisfiableError)
        this.rangeFailure(object.sizeBytes, response);
      throw error;
    }
    if (!stored)
      throw new NotFoundException({
        code: "MEDIA_OBJECT_NOT_FOUND",
        message: "Media object was not found.",
      });
    response.statusCode = stored.contentRange ? 206 : 200;
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Length", String(stored.contentLength));
    if (stored.contentRange)
      response.setHeader("Content-Range", stored.contentRange);
    if (stored.etag) response.setHeader("ETag", stored.etag);
    const fallback =
      object.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) ||
      "editorial-package.zip";
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(object.filename)}`,
    );
    stored.body.on("error", () => response.destroy());
    stored.body.pipe(response);
  }

  private rangeFailure(size: bigint, response: ServerResponse): never {
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Range", `bytes */${size}`);
    throw new HttpException(
      {
        code: "RANGE_NOT_SATISFIABLE",
        message: "The requested byte range is not satisfiable.",
      },
      HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (error instanceof EditorialExportAuthorizationError)
      throw new ForbiddenException({
        code: "EDITORIAL_EXPORT_AUTHORIZATION_REQUIRED",
        message: "Usable source and montage rights are required.",
      });
    if (error instanceof EditorialExportNotFoundError)
      throw new NotFoundException({
        code: "EDITORIAL_EXPORT_NOT_FOUND",
        message: "Editorial export was not found.",
      });
    if (error instanceof EditorialExportIdempotencyConflictError)
      throw new ConflictException({
        code: "IDEMPOTENCY_CONFLICT",
        message: "This key belongs to a different editorial operation.",
      });
    if (error instanceof EditorialExportApprovalStaleError)
      throw new ConflictException({
        code: "EDITORIAL_APPROVAL_STALE",
        message: "The approval is no longer current. Refresh before export.",
      });
    if (error instanceof EditorialExportLineageInvalidError)
      throw new ConflictException({
        code: "EDITORIAL_EXPORT_LINEAGE_INVALID",
        message: "Stored editorial export lineage is invalid.",
      });
    if (error instanceof EditorialExportResultNotReadyError)
      throw new ConflictException({
        code: "EDITORIAL_EXPORT_NOT_READY",
        message: "The current export package is not ready.",
      });
    if (error instanceof EditorialExportCursorInvalidError)
      throw new BadRequestException({
        code: "EDITORIAL_EXPORT_CURSOR_INVALID",
        message: "Cursor does not belong to this project.",
      });
    if (error instanceof EditorialExportUnavailableError)
      throw new ServiceUnavailableException({
        code: "EDITORIAL_EXPORT_DISABLED",
        message: "Editorial export admission is temporarily disabled.",
      });
    throw error;
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{8,200}$/.test(value))
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "A valid Idempotency-Key header is required.",
    });
  return value;
}

function byteRangeState(
  value: string,
  size: bigint,
): "valid" | "invalid" | "unsatisfiable" {
  if (value.includes(",")) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";
  try {
    if (!match[1]) return BigInt(match[2]!) === 0n ? "unsatisfiable" : "valid";
    const start = BigInt(match[1]);
    if (start >= size) return "unsatisfiable";
    if (match[2] && BigInt(match[2]) < start) return "unsatisfiable";
    return "valid";
  } catch {
    return "invalid";
  }
}
