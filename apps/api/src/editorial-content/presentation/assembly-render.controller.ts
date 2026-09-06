import type { ServerResponse } from "node:http";

import {
  BadRequestException,
  Body,
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
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBody,
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
import { CreateAssemblyRender } from "../application/create-assembly-render.js";
import {
  GetAssemblyRender,
  GetAssemblyRenderContent,
  ListAssemblyRenders,
} from "../application/assembly-render-queries.js";
import {
  AssemblyRenderAuthorizationError,
  AssemblyRenderCursorInvalidError,
  AssemblyRenderCutNotReadyError,
  AssemblyRenderIdempotencyConflictError,
  AssemblyRenderLimitsError,
  AssemblyRenderLineageInvalidError,
  AssemblyRenderNotFoundError,
  AssemblyRenderProfileUnsupportedError,
  AssemblyRenderRecipeNotFoundError,
  AssemblyRenderRevisionConflictError,
  AssemblyRenderResultNotReadyError,
  AssemblyRenderUnavailableError,
} from "../domain/assembly-render.js";
import {
  AssemblyRenderListQueryDto,
  AssemblyRenderListResponseDto,
  AssemblyRenderResponseDto,
  CreateAssemblyRenderDto,
} from "./assembly-render.dto.js";
import { assemblyRenderResponse } from "./assembly-render-response.js";
import { ErrorResponseDto } from "../../projects/presentation/project.dto.js";

const VIDEO_RESPONSE_CONTENT = {
  "video/mp4": { schema: { type: "string", format: "binary" } },
};
const BYTE_RANGE_HEADERS = {
  "Accept-Ranges": {
    description: "Supported range unit.",
    schema: { type: "string", example: "bytes" },
  },
  "Content-Range": {
    description: "Returned byte range.",
    schema: { type: "string", example: "bytes 0-1023/4096" },
  },
};

@ApiTags("editorial-content")
@ApiExtraModels(ErrorResponseDto)
@Controller("api/v1")
export class AssemblyRenderController {
  constructor(
    @Inject(CreateAssemblyRender)
    private readonly createRender: CreateAssemblyRender,
    @Inject(GetAssemblyRender)
    private readonly getRender: GetAssemblyRender,
    @Inject(ListAssemblyRenders)
    private readonly listRenders: ListAssemblyRenders,
    @Inject(GetAssemblyRenderContent)
    private readonly getContent: GetAssemblyRenderContent,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Post("pipeline-jobs/:cutJobId/assembly-renders")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Create one exact-revision background horizontal render",
  })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreateAssemblyRenderDto })
  @ApiResponse({ status: 202, type: AssemblyRenderResponseDto })
  @ApiResponse({ status: 400 })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409 })
  @ApiResponse({ status: 422 })
  @ApiResponse({ status: 503 })
  async create(
    @Param("cutJobId", new ParseUUIDPipe({ version: "4" })) cutJobId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateAssemblyRenderDto,
  ): Promise<AssemblyRenderResponseDto> {
    try {
      return assemblyRenderResponse(
        await this.createRender.execute({
          cutPipelineJobId: cutJobId,
          recipeRevision: body.recipeRevision,
          idempotencyKey: requireIdempotencyKey(idempotencyKey),
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("assembly-renders/:renderId")
  @ApiOkResponse({ type: AssemblyRenderResponseDto })
  async one(
    @Param("renderId", new ParseUUIDPipe({ version: "4" })) renderId: string,
  ): Promise<AssemblyRenderResponseDto> {
    try {
      const value = await this.getRender.execute(renderId);
      if (!value)
        throw new NotFoundException({
          code: "ASSEMBLY_RENDER_NOT_FOUND",
          message: "Assembly render was not found.",
        });
      return assemblyRenderResponse(value);
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("projects/:projectId/assembly-renders")
  @ApiOkResponse({ type: AssemblyRenderListResponseDto })
  async project(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query() query: AssemblyRenderListQueryDto,
  ): Promise<AssemblyRenderListResponseDto> {
    try {
      const values = await this.listRenders.execute({
        projectId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit + 1,
      });
      const hasMore = values.length > query.limit;
      const page = values.slice(0, query.limit);
      return {
        items: page.map(assemblyRenderResponse),
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("assembly-renders/:renderId/content")
  @ApiProduces("video/mp4")
  @ApiHeader({
    name: "Range",
    required: false,
    description: "One RFC 9110 byte range.",
  })
  @ApiOkResponse({
    description: "Ready private horizontal MP4.",
    headers: { "Accept-Ranges": BYTE_RANGE_HEADERS["Accept-Ranges"] },
    content: VIDEO_RESPONSE_CONTENT,
  })
  @ApiResponse({
    status: 206,
    description: "Requested MP4 byte range.",
    headers: BYTE_RANGE_HEADERS,
    content: VIDEO_RESPONSE_CONTENT,
  })
  @ApiResponse({
    status: 416,
    description: "Unsatisfied byte range.",
    headers: {
      "Accept-Ranges": BYTE_RANGE_HEADERS["Accept-Ranges"],
      "Content-Range": {
        description: "Unsatisfied range with authoritative object size.",
        schema: { type: "string", example: "bytes */4096" },
      },
    },
    content: {
      "application/json": { schema: { $ref: getSchemaPath(ErrorResponseDto) } },
    },
  })
  async content(
    @Param("renderId", new ParseUUIDPipe({ version: "4" })) renderId: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    let object;
    try {
      object = await this.getContent.execute(renderId);
    } catch (error) {
      this.rethrow(error);
    }
    if (range) {
      const status = byteRangeStatus(range, object.sizeBytes);
      if (status === "invalid")
        throw new BadRequestException({
          code: "RANGE_INVALID",
          message: "Only one byte range is supported.",
        });
      if (status === "unsatisfiable")
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
    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Content-Length", String(stored.contentLength));
    if (stored.contentRange)
      response.setHeader("Content-Range", stored.contentRange);
    if (stored.etag) response.setHeader("ETag", stored.etag);
    const fallback =
      object.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) ||
      "assembled.mp4";
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
    if (error instanceof AssemblyRenderAuthorizationError)
      throw new ForbiddenException({
        code: "ASSEMBLY_RENDER_AUTHORIZATION_REQUIRED",
        message: "Usable source and montage rights are required.",
      });
    if (error instanceof AssemblyRenderIdempotencyConflictError)
      throw new ConflictException({
        code: "IDEMPOTENCY_CONFLICT",
        message: "This key belongs to a different assembly render request.",
      });
    if (error instanceof AssemblyRenderCutNotReadyError)
      throw new ConflictException({
        code: "CUT_RESULT_NOT_READY",
        message: "A READY cut result is required.",
      });
    if (error instanceof AssemblyRenderRevisionConflictError)
      throw new ConflictException({
        code: "ASSEMBLY_REVISION_CONFLICT",
        message: "The recipe changed. Refresh before rendering.",
      });
    if (error instanceof AssemblyRenderLineageInvalidError)
      throw new ConflictException({
        code: "ASSEMBLY_RENDER_LINEAGE_INVALID",
        message: "Stored render input lineage is invalid.",
      });
    if (error instanceof AssemblyRenderRecipeNotFoundError)
      throw new NotFoundException({
        code: "ASSEMBLY_RECIPE_NOT_FOUND",
        message: "The requested assembly recipe revision was not found.",
      });
    if (error instanceof AssemblyRenderProfileUnsupportedError)
      throw new UnprocessableEntityException({
        code: "ASSEMBLY_PROFILE_UNSUPPORTED",
        message: "The assembly profile is not supported.",
      });
    if (error instanceof AssemblyRenderLimitsError)
      throw new UnprocessableEntityException({
        code: "ASSEMBLY_RENDER_LIMITS_EXCEEDED",
        message: "The render exceeds the supported input or duration limits.",
      });
    if (error instanceof AssemblyRenderCursorInvalidError)
      throw new BadRequestException({
        code: "ASSEMBLY_RENDER_CURSOR_INVALID",
        message: "Cursor does not belong to this project.",
      });
    if (error instanceof AssemblyRenderNotFoundError)
      throw new NotFoundException({
        code: "ASSEMBLY_RENDER_NOT_FOUND",
        message: "Assembly render was not found.",
      });
    if (error instanceof AssemblyRenderResultNotReadyError)
      throw new ConflictException({
        code: "ASSEMBLY_RESULT_NOT_READY",
        message: "The assembled result is not ready.",
      });
    if (error instanceof AssemblyRenderUnavailableError)
      throw new ServiceUnavailableException({
        code: "ASSEMBLY_RENDER_DISABLED",
        message: "Horizontal render admission is temporarily disabled.",
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

function byteRangeStatus(
  range: string,
  size: bigint,
): "satisfiable" | "unsatisfiable" | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (match[1]) {
    const start = BigInt(match[1]);
    if (start >= size || (match[2] && BigInt(match[2]) < start))
      return "unsatisfiable";
    return "satisfiable";
  }
  return BigInt(match[2]!) === 0n || size === 0n
    ? "unsatisfiable"
    : "satisfiable";
}
