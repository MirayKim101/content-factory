import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Header,
  HttpCode,
  Post,
  Param,
  ParseUUIDPipe,
  NotFoundException,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ApiOkResponse, ApiResponse, ApiTags } from "@nestjs/swagger";

import { TwitchIngestionService } from "../application/twitch-ingestion.service.js";
import {
  TwitchChannelNotAllowedError,
  TwitchEventConflictError,
  TwitchEventInvalidError,
  TwitchIngestionDisabledError,
  TwitchSignatureInvalidError,
} from "../domain/twitch-ingestion.js";
import {
  CreateTwitchIngestChannelDto,
  TwitchIngestChannelResponseDto,
} from "./twitch-ingestion.dto.js";

@ApiTags("twitch-ingestion")
@Controller("api/v1/twitch")
export class TwitchIngestionController {
  constructor(private readonly service: TwitchIngestionService) {}

  @Get("channels")
  @ApiOkResponse({ type: [TwitchIngestChannelResponseDto] })
  channels() {
    return this.service.listChannels();
  }

  @Post("channels")
  @ApiResponse({ status: 201, type: TwitchIngestChannelResponseDto })
  channel(@Body() body: CreateTwitchIngestChannelDto) {
    return this.service.createChannel(body);
  }

  @Post("channels/:id/revoke")
  @ApiOkResponse({ type: TwitchIngestChannelResponseDto })
  async revoke(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    const channel = await this.service.revokeChannel(id);
    if (!channel)
      throw new NotFoundException({ code: "TWITCH_CHANNEL_NOT_FOUND" });
    return channel;
  }

  @Post("eventsub")
  @HttpCode(202)
  @Header("Content-Type", "text/plain")
  async event(
    @Req() request: { rawBody?: Buffer },
    @Body() body: unknown,
    @Headers("twitch-eventsub-message-id") messageId: string | undefined,
    @Headers("twitch-eventsub-message-timestamp")
    messageTimestamp: string | undefined,
    @Headers("twitch-eventsub-message-type") messageType: string | undefined,
    @Headers("twitch-eventsub-message-signature") signature: string | undefined,
    @Headers("twitch-eventsub-subscription-type")
    subscriptionType: string | undefined,
    @Headers("twitch-eventsub-subscription-version")
    subscriptionVersion: string | undefined,
  ) {
    try {
      const result = await this.service.receive(
        {
          messageId,
          messageTimestamp,
          messageType,
          signature,
          subscriptionType,
          subscriptionVersion,
        },
        request.rawBody,
        body,
      );
      return result.challenge ?? "accepted";
    } catch (error) {
      if (error instanceof TwitchIngestionDisabledError)
        throw new ServiceUnavailableException({
          code: "TWITCH_INGESTION_DISABLED",
        });
      if (error instanceof TwitchSignatureInvalidError)
        throw new ForbiddenException({ code: "TWITCH_SIGNATURE_INVALID" });
      if (error instanceof TwitchChannelNotAllowedError)
        throw new ForbiddenException({ code: "TWITCH_CHANNEL_NOT_ALLOWED" });
      if (error instanceof TwitchEventConflictError)
        throw new ConflictException({ code: "TWITCH_EVENT_CONFLICT" });
      if (error instanceof TwitchEventInvalidError)
        throw new UnprocessableEntityException({
          code: "TWITCH_EVENT_INVALID",
        });
      throw error;
    }
  }
}
