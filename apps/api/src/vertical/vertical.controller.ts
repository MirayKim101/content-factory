import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
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

@ApiTags("vertical")
@Controller("api/v1")
export class VerticalController {
  constructor(private readonly service: VerticalService) {}

  @Post("projects/:projectId/vertical-renders")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 201, type: VerticalRenderResponseDto })
  create(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreateVerticalRenderDto,
  ) {
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key))
      throw new BadRequestException({ code: "IDEMPOTENCY_KEY_INVALID" });
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
      throw new NotFoundException({ code: "VERTICAL_RENDER_NOT_FOUND" });
    return value;
  }

  @Post("vertical-renders/:id/approve")
  approve(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return this.wrap(() => this.service.approve(id));
  }

  private async wrap<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VerticalUnavailableError)
        throw new ServiceUnavailableException({
          code: "VERTICAL_RENDER_DISABLED",
        });
      if (
        error instanceof VerticalLineageInvalidError ||
        error instanceof VerticalIdempotencyConflictError
      )
        throw new ConflictException({ code: "VERTICAL_RENDER_CONFLICT" });
      if (error instanceof VerticalNotFoundError)
        throw new NotFoundException({ code: "VERTICAL_RENDER_NOT_FOUND" });
      throw error;
    }
  }
}
