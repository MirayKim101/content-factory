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
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiHeader,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { CreatePublicationIntent } from "../application/create-publication-intent.js";
import {
  CreatePublicationChannel,
  ListPublicationChannels,
} from "../application/publication-channel-commands.js";
import {
  CancelPublicationIntent,
  GetPublicationIntent,
  ListPublicationIntents,
} from "../application/publication-queries.js";
import {
  PublicationCancellationConflictError,
  PublicationChannelConflictError,
  PublicationCursorInvalidError,
  PublicationIdempotencyConflictError,
  PublicationLineageInvalidError,
  PublicationMetadataInvalidError,
  PublicationScheduleInvalidError,
  PublicationTimezoneInvalidError,
  PublishingUnavailableError,
} from "../domain/publication.js";
import {
  CreatePublicationChannelDto,
  CreatePublicationIntentDto,
  PublicationChannelResponseDto,
  PublicationIntentListResponseDto,
  PublicationIntentResponseDto,
  PublicationListQueryDto,
} from "./publication.dto.js";
import {
  publicationChannelResponse,
  publicationIntentResponse,
} from "./publication-response.js";

@ApiTags("publishing")
@Controller("api/v1")
export class PublicationController {
  constructor(
    private readonly createChannel: CreatePublicationChannel,
    private readonly listChannels: ListPublicationChannels,
    private readonly createIntent: CreatePublicationIntent,
    private readonly getIntent: GetPublicationIntent,
    private readonly listIntents: ListPublicationIntents,
    private readonly cancelIntent: CancelPublicationIntent,
  ) {}

  @Post("projects/:projectId/publication-channels")
  @ApiResponse({ status: 201, type: PublicationChannelResponseDto })
  async channel(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Body() body: CreatePublicationChannelDto,
  ) {
    try {
      return publicationChannelResponse(
        await this.createChannel.execute({ projectId, ...body }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("projects/:projectId/publication-channels")
  @ApiOkResponse({ type: [PublicationChannelResponseDto] })
  async channels(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
  ) {
    return (await this.listChannels.execute(projectId)).map(
      publicationChannelResponse,
    );
  }

  @Post("projects/:projectId/publications")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiResponse({ status: 202, type: PublicationIntentResponseDto })
  async create(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreatePublicationIntentDto,
  ) {
    try {
      return publicationIntentResponse(
        await this.createIntent.execute({
          projectId,
          idempotencyKey: requireKey(key),
          ...body,
        }),
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("publications/:id")
  @ApiOkResponse({ type: PublicationIntentResponseDto })
  async one(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    const value = await this.getIntent.execute(id);
    if (!value)
      throw new NotFoundException({
        code: "PUBLICATION_NOT_FOUND",
        message: "Publication was not found.",
      });
    return publicationIntentResponse(value);
  }

  @Get("projects/:projectId/publications")
  @ApiOkResponse({ type: PublicationIntentListResponseDto })
  async project(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query() query: PublicationListQueryDto,
  ) {
    try {
      const rows = await this.listIntents.execute({
        projectId,
        ...(query.channelId ? { channelId: query.channelId } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      return {
        items: items.map(publicationIntentResponse),
        nextCursor:
          rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Post("publications/:id/cancel")
  @ApiOkResponse({ type: PublicationIntentResponseDto })
  async cancel(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    try {
      return publicationIntentResponse(await this.cancelIntent.execute(id));
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (error instanceof PublishingUnavailableError)
      throw new ServiceUnavailableException({
        code: "PUBLISHING_DISABLED",
        message: "Publishing is disabled.",
      });
    if (
      error instanceof PublicationScheduleInvalidError ||
      error instanceof PublicationTimezoneInvalidError ||
      error instanceof PublicationMetadataInvalidError ||
      error instanceof PublicationCursorInvalidError
    )
      throw new BadRequestException({
        code: "PUBLICATION_REQUEST_INVALID",
        message: "Publication request is invalid.",
      });
    if (
      error instanceof PublicationIdempotencyConflictError ||
      error instanceof PublicationChannelConflictError ||
      error instanceof PublicationCancellationConflictError ||
      error instanceof PublicationLineageInvalidError
    )
      throw new ConflictException({
        code: "PUBLICATION_CONFLICT",
        message: "Publication state or lineage conflicts with this request.",
      });
    throw error;
  }
}

function requireKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._:-]{8,200}$/.test(value))
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_INVALID",
      message: "Idempotency-Key is invalid.",
    });
  return value;
}
