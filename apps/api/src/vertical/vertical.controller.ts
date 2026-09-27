import type { ServerResponse } from "node:http";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiHeader,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import {
  CreateVerticalRenderDto,
  VerticalRenderResponseDto,
} from "./vertical.dto.js";
import {
  VerticalIdempotencyConflictError,
  VerticalLineageInvalidError,
  VerticalNotFoundError,
  VerticalService,
  VerticalUnavailableError,
} from "./vertical.service.js";
import {
  OBJECT_STORAGE,
  ObjectRangeNotSatisfiableError,
  type ObjectStorage,
} from "../projects/application/object-storage.port.js";

@ApiTags("vertical")
@Controller("api/v1")
export class VerticalController {
  constructor(
    @Inject(VerticalService) private readonly service: VerticalService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Post("projects/:projectId/vertical-renders")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 201, type: VerticalRenderResponseDto })
  create(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreateVerticalRenderDto,
  ) {
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key))
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Idempotency-Key is invalid.",
      });
    return this.wrap(() =>
      this.service.create({ projectId, idempotencyKey: key, ...body }),
    );
  }

  @Get("projects/:projectId/vertical-renders")
  @ApiOkResponse({ type: [VerticalRenderResponseDto] })
  list(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
  ) {
    return this.service.list(projectId);
  }

  @Get("vertical-renders/:id")
  @ApiOkResponse({ type: VerticalRenderResponseDto })
  async get(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    const value = await this.service.get(id);
    if (!value)
      throw new NotFoundException({
        code: "VERTICAL_RENDER_NOT_FOUND",
        message: "Vertical render was not found.",
      });
    return value;
  }

  @Post("vertical-renders/:id/approve")
  approve(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.wrap(() => this.service.approve(id));
  }

  @Get("vertical-renders/:id/content")
  async content(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const object = await this.wrap(() => this.service.content(id));
    if (!this.storage.readObject)
      throw new Error("MEDIA_STORAGE_STREAMING_UNAVAILABLE");
    let stored;
    try {
      stored = await this.storage.readObject(object.objectKey, range);
    } catch (error) {
      if (error instanceof ObjectRangeNotSatisfiableError) {
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Content-Range", `bytes */${object.sizeBytes}`);
        throw new HttpException(
          { code: "RANGE_NOT_SATISFIABLE" },
          HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
        );
      }
      throw error;
    }
    if (!stored)
      throw new NotFoundException({ code: "MEDIA_OBJECT_NOT_FOUND" });
    response.statusCode = stored.contentRange ? 206 : 200;
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Content-Length", String(stored.contentLength));
    if (stored.contentRange)
      response.setHeader("Content-Range", stored.contentRange);
    if (stored.etag) response.setHeader("ETag", stored.etag);
    response.setHeader(
      "Content-Disposition",
      `inline; filename="vertical-${id}.mp4"`,
    );
    stored.body.on("error", () => response.destroy());
    stored.body.pipe(response);
  }

  private async wrap<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VerticalUnavailableError)
        throw new ServiceUnavailableException({
          code: "VERTICAL_RENDER_DISABLED",
          message: "Vertical rendering is disabled.",
        });
      if (
        error instanceof VerticalLineageInvalidError ||
        error instanceof VerticalIdempotencyConflictError
      )
        throw new ConflictException({
          code: "VERTICAL_RENDER_CONFLICT",
          message: "Vertical render lineage conflicts with this request.",
        });
      if (error instanceof VerticalNotFoundError)
        throw new NotFoundException({
          code: "VERTICAL_RENDER_NOT_FOUND",
          message: "Vertical render was not found.",
        });
      throw error;
    }
  }
}
