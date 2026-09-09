import type { IncomingMessage, ServerResponse } from "node:http";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Head,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  decodePageCursor,
  encodePageCursor,
} from "@content-factory/manual-cut";

import { ErrorResponseDto } from "../projects/presentation/project.dto.js";
import { CutJobService } from "./cut-job.service.js";
import { CreateCutJobDto, CutJobDto, CutJobPageDto } from "./cut.dto.js";
import { toCutJobDto } from "./cut-response.js";
import { MediaStreamService } from "./media-stream.js";

@ApiTags("manual cuts")
@Controller("api/v1/projects/:projectId")
export class CutsController {
  constructor(
    private readonly cuts: CutJobService,
    private readonly media: MediaStreamService,
  ) {}

  @Post("cut-jobs")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Persist and enqueue an accurate manual horizontal cut",
  })
  @ApiParam({ name: "projectId", schema: { type: "string", format: "uuid" } })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiAcceptedResponse({ type: CutJobDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  async create(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateCutJobDto,
  ): Promise<CutJobDto> {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey))
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "A valid Idempotency-Key header is required.",
      });
    if (body.startMs >= body.endMs)
      throw new BadRequestException({
        code: "INVALID_CUT_RANGE",
        message: "startMs must be less than endMs.",
      });
    return toCutJobDto(
      await this.cuts.create({
        projectId,
        idempotencyKey,
        startMs: body.startMs,
        endMs: body.endMs,
      }),
    );
  }

  @Get("cut-jobs")
  @ApiOkResponse({ type: CutJobPageDto })
  @ApiParam({
    name: "projectId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({ name: "cursor", required: false, schema: { type: "string" } })
  async list(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query("limit") rawLimit?: string,
    @Query("cursor") rawCursor?: string,
  ): Promise<CutJobPageDto> {
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "limit must be an integer from 1 to 100.",
      });
    const cursor = rawCursor ? decodePageCursor(rawCursor) : null;
    if (rawCursor && !cursor)
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "cursor is invalid.",
      });
    const rows = await this.cuts.list(projectId, limit + 1, cursor);
    const hasNext = rows.length > limit;
    const items = rows.slice(0, limit);
    const tail = items.at(-1);
    return {
      items: items.map(toCutJobDto),
      nextCursor:
        hasNext && tail
          ? encodePageCursor({ createdAt: tail.createdAt, id: tail.id })
          : null,
    };
  }

  @Get("cut-jobs/:jobId")
  @ApiOkResponse({ type: CutJobDto })
  @ApiParam({
    name: "projectId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiParam({
    name: "jobId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async get(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
  ): Promise<CutJobDto> {
    return toCutJobDto(await this.cuts.get(projectId, jobId));
  }

  @Get("source/media")
  @ApiParam({
    name: "projectId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiHeader({
    name: "Range",
    required: false,
    description: "A single RFC 7233 bytes range.",
  })
  @ApiResponse({
    status: 200,
    description: "Full authorized source stream.",
    content: { "video/mp4": { schema: { type: "string", format: "binary" } } },
  })
  @ApiResponse({
    status: 206,
    description: "Authorized source byte range.",
    content: { "video/mp4": { schema: { type: "string", format: "binary" } } },
  })
  @ApiResponse({
    status: 416,
    description: "Malformed, multiple, or unsatisfiable range.",
  })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async source(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    await this.sendSource(projectId, request, response, false);
  }

  @Head("source/media")
  @ApiParam({
    name: "projectId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiHeader({
    name: "Range",
    required: false,
    description: "A single RFC 7233 bytes range.",
  })
  @ApiResponse({ status: 200, description: "Authorized source metadata." })
  @ApiResponse({
    status: 206,
    description: "Authorized source range metadata.",
  })
  @ApiResponse({
    status: 416,
    description: "Malformed, multiple, or unsatisfiable range.",
  })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async headSource(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    await this.sendSource(projectId, request, response, true);
  }

  @Get("cut-jobs/:jobId/download")
  @ApiParam({
    name: "projectId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiParam({
    name: "jobId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiHeader({
    name: "Range",
    required: false,
    description: "A single RFC 7233 bytes range.",
  })
  @ApiResponse({
    status: 200,
    description: "Full ready cut stream.",
    content: { "video/mp4": { schema: { type: "string", format: "binary" } } },
  })
  @ApiResponse({
    status: 206,
    description: "Ready cut byte range.",
    content: { "video/mp4": { schema: { type: "string", format: "binary" } } },
  })
  @ApiResponse({
    status: 416,
    description: "Malformed, multiple, or unsatisfiable range.",
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async download(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    await this.sendDownload(projectId, jobId, request, response, false);
  }

  @Head("cut-jobs/:jobId/download")
  @ApiParam({
    name: "projectId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiParam({
    name: "jobId",
    required: true,
    schema: { type: "string", format: "uuid" },
  })
  @ApiHeader({
    name: "Range",
    required: false,
    description: "A single RFC 7233 bytes range.",
  })
  @ApiResponse({ status: 200, description: "Ready cut metadata." })
  @ApiResponse({ status: 206, description: "Ready cut range metadata." })
  @ApiResponse({
    status: 416,
    description: "Malformed, multiple, or unsatisfiable range.",
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async headDownload(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Param("jobId", new ParseUUIDPipe({ version: "4" })) jobId: string,
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    await this.sendDownload(projectId, jobId, request, response, true);
  }

  private async sendSource(
    projectId: string,
    request: IncomingMessage,
    response: ServerResponse,
    head: boolean,
  ): Promise<void> {
    const result = await this.cuts
      .repository()
      .getAuthorizedSourceMedia(projectId);
    if (result.outcome !== "READY") this.throwMedia(result.outcome);
    await this.media.send({
      request,
      response,
      ...result.media,
      disposition: "inline",
      head,
    });
  }

  private async sendDownload(
    projectId: string,
    jobId: string,
    request: IncomingMessage,
    response: ServerResponse,
    head: boolean,
  ): Promise<void> {
    const result = await this.cuts
      .repository()
      .getReadyDownload(projectId, jobId);
    if (result.outcome === "CUT_JOB_NOT_FOUND")
      throw new NotFoundException({
        code: "CUT_JOB_NOT_FOUND",
        message: "Cut job was not found.",
      });
    if (result.outcome === "CUT_NOT_READY")
      throw new ConflictException({
        code: "CUT_NOT_READY",
        message: "The cut output is not ready.",
      });
    if (result.outcome !== "READY") this.throwMedia(result.outcome);
    await this.media.send({
      request,
      response,
      ...result.media,
      disposition: "attachment",
      head,
    });
  }

  private throwMedia(
    outcome: "PROJECT_NOT_FOUND" | "SOURCE_NOT_READY" | "SOURCE_NOT_AUTHORIZED",
  ): never {
    if (outcome === "PROJECT_NOT_FOUND")
      throw new NotFoundException({
        code: "PROJECT_NOT_FOUND",
        message: "Project was not found.",
      });
    if (outcome === "SOURCE_NOT_READY")
      throw new ConflictException({
        code: "SOURCE_NOT_READY",
        message: "The source is not ready.",
      });
    throw new ForbiddenException({
      code: "SOURCE_NOT_AUTHORIZED",
      message: "The exact source version is not authorized.",
    });
  }
}
