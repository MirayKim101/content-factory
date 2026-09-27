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
  Res,
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
  TwitchVodConflictError,
} from "../domain/twitch-ingestion.js";
import {
  CreateTwitchIngestChannelDto,
  LinkTwitchVodProjectDto,
  TwitchIngestChannelResponseDto,
  TwitchVodCandidateResponseDto,
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

  @Get("vod-candidates")
  @ApiOkResponse({ type: [TwitchVodCandidateResponseDto] })
  vodCandidates() {
    return this.service.listVodCandidates();
  }

  @Post("vod-candidates/:id/ignore")
  @ApiOkResponse({ type: TwitchVodCandidateResponseDto })
  async ignoreVodCandidate(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ) {
    try {
      const candidate = await this.service.ignoreVodCandidate(id);
      if (!candidate)
        throw new NotFoundException({
          code: "TWITCH_VOD_NOT_FOUND",
          message: "Twitch VOD candidate was not found.",
        });
      return candidate;
    } catch (error) {
      if (error instanceof TwitchVodConflictError)
        throw new ConflictException({
          code: "TWITCH_VOD_CONFLICT",
          message: "Imported Twitch VOD cannot be ignored.",
        });
      throw error;
    }
  }

  @Post("vod-candidates/:id/link-project")
  @ApiOkResponse({ type: TwitchVodCandidateResponseDto })
  async linkVodProject(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() body: LinkTwitchVodProjectDto,
  ) {
    try {
      const candidate = await this.service.linkVodCandidateToProject(
        id,
        body.projectId,
        body.sourceMatchConfirmed,
      );
      if (!candidate)
        throw new NotFoundException({
          code: "TWITCH_VOD_NOT_FOUND",
          message: "Twitch VOD candidate was not found.",
        });
      return candidate;
    } catch (error) {
      if (error instanceof TwitchVodConflictError)
        throw new ConflictException({
          code: "TWITCH_VOD_LINK_CONFLICT",
          message: "Only a ready VOD and a source-ready project can be linked.",
        });
      throw error;
    }
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
      throw new NotFoundException({
        code: "TWITCH_CHANNEL_NOT_FOUND",
        message: "Twitch channel was not found.",
      });
    return channel;
  }

  @Post("eventsub")
  @HttpCode(202)
  @Header("Content-Type", "text/plain")
  async event(
    @Req() request: { rawBody?: Buffer },
    @Res({ passthrough: true }) response: { status(code: number): unknown },
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
      if (result.challenge !== undefined) response.status(200);
      return result.challenge ?? "accepted";
    } catch (error) {
      if (error instanceof TwitchIngestionDisabledError)
        throw new ServiceUnavailableException({
          code: "TWITCH_INGESTION_DISABLED",
          message: "Twitch ingestion is disabled.",
        });
      if (error instanceof TwitchSignatureInvalidError)
        throw new ForbiddenException({
          code: "TWITCH_SIGNATURE_INVALID",
          message: "Twitch signature is invalid.",
        });
      if (error instanceof TwitchChannelNotAllowedError)
        throw new ForbiddenException({
          code: "TWITCH_CHANNEL_NOT_ALLOWED",
          message: "Twitch channel is not allowed.",
        });
      if (error instanceof TwitchEventConflictError)
        throw new ConflictException({
          code: "TWITCH_EVENT_CONFLICT",
          message: "Twitch event conflicts with an existing message.",
        });
      if (error instanceof TwitchEventInvalidError)
        throw new UnprocessableEntityException({
          code: "TWITCH_EVENT_INVALID",
          message: "Twitch event is invalid.",
        });
      throw error;
    }
  }
}
