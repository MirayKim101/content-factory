import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
  BadRequestException,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Queue } from "bullmq";

import { apiEnvironment } from "../../config/environment.js";
import { CreateCuts } from "../../media-pipeline/application/create-cuts.js";
import { toCreateCutsResponse } from "../../media-pipeline/presentation/pipeline-response.js";
import {
  AcceptClipSuggestionsDto,
  CreateClipGenerationDto,
} from "./clip-generation.dto.js";
import { ClipGenerationService } from "./clip-generation.service.js";

@ApiTags("clip-generation")
@Controller("api/v1")
export class ClipGenerationController implements OnModuleDestroy {
  private readonly queue: Queue | null;
  constructor(
    private readonly service: ClipGenerationService,
    private readonly createCuts: CreateCuts,
  ) {
    const config = apiEnvironment();
    this.queue =
      config.clipGenerationEnabled && !config.mediaQueueDisabled
        ? new Queue("ai-clip-generation-v1", {
            connection: {
              host: config.redisHost,
              port: config.redisPort,
              password: config.redisPassword,
              maxRetriesPerRequest: 1,
              enableOfflineQueue: false,
              lazyConnect: true,
            },
          })
        : null;
  }

  @Post("projects/:projectId/clip-generations")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam({ name: "projectId", format: "uuid" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiAcceptedResponse({ description: "Durable clip generation intent" })
  async create(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: CreateClipGenerationDto,
  ) {
    this.requireEnabled();
    const idempotencyKey = key?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new BadRequestException({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    const intent = await this.service.create(projectId, idempotencyKey, body);
    const existing = await this.queue!.getJob(intent.id as string);
    if (
      !existing ||
      !["waiting", "active", "delayed", "completed"].includes(
        await existing.getState(),
      )
    ) {
      if (existing) await existing.remove();
      await this.queue!.add(
        "clip-generation-v1",
        { schemaVersion: 1, intentId: intent.id },
        {
          jobId: intent.id as string,
          attempts: 2,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 86_400, count: 5_000 },
        },
      );
    }
    return intent;
  }

  @Get("clip-generations/:intentId")
  @ApiParam({ name: "intentId", format: "uuid" })
  @ApiOkResponse({ description: "Clip generation status and suggestions" })
  detail(
    @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string,
  ) {
    this.requireEnabled();
    return this.service.detail(intentId);
  }

  @Post("clip-generations/:intentId/accept")
  @ApiParam({ name: "intentId", format: "uuid" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async accept(
    @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: AcceptClipSuggestionsDto,
  ) {
    this.requireEnabled();
    const idempotencyKey = key?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey))
      throw new BadRequestException({ code: "IDEMPOTENCY_KEY_INVALID" });
    const resolved = await this.service.resolveAcceptance(
      intentId,
      body.suggestionIds,
    );
    const result = await this.createCuts.execute({
      projectId: resolved.projectId,
      idempotencyKey,
      segments: resolved.segments,
    });
    await this.service.recordAcceptance({
      intentId,
      cutRequestId: result.requestId,
      idempotencyKey,
      suggestionIds: body.suggestionIds,
    });
    return toCreateCutsResponse(result);
  }

  private requireEnabled(): void {
    const config = apiEnvironment();
    if (
      !config.clipGenerationEnabled ||
      !config.clipGenerationModel ||
      !this.queue
    )
      throw new ServiceUnavailableException({
        code: "CLIP_GENERATION_DISABLED",
      });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}
