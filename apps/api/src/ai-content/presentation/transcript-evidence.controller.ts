import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Head,
  Res,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiHeader,
  ApiNotFoundResponse,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { isUuidV4 } from "../domain/creator-context.js";
import { AiContentIdempotencyConflictError } from "../application/creator-context-repository.port.js";
import {
  TRANSCRIPT_EVIDENCE_REPOSITORY,
  type TranscriptEvidenceRepository,
  TranscriptContextRejectedError,
} from "../application/transcript-evidence-repository.port.js";
import {
  TRANSCRIPT_EVIDENCE_DISPATCH,
  type TranscriptEvidenceDispatch,
} from "../application/transcript-evidence-dispatch.port.js";
import {
  CreateTranscriptEvidenceDto,
  TranscriptEvidenceDto,
  TranscriptEvidenceErrorResponseDto,
} from "./transcript-evidence.dto.js";
import {
  CREATOR_CONTEXT_STORAGE,
  type CreatorContextStorage,
} from "../application/creator-context-storage.port.js";
import { ObjectRangeNotSatisfiableError } from "../../projects/application/object-storage.port.js";

const uuid = new ParseUUIDPipe({ version: "4" });

@ApiTags("transcript-evidence")
@ApiResponse({ status: 400, type: TranscriptEvidenceErrorResponseDto })
@ApiResponse({ status: 409, type: TranscriptEvidenceErrorResponseDto })
@Controller("api/v1")
export class TranscriptEvidenceController {
  constructor(
    @Inject(TRANSCRIPT_EVIDENCE_REPOSITORY)
    private readonly repository: TranscriptEvidenceRepository,
    @Inject(TRANSCRIPT_EVIDENCE_DISPATCH)
    private readonly dispatch: TranscriptEvidenceDispatch,
    @Inject(CREATOR_CONTEXT_STORAGE)
    private readonly storage: CreatorContextStorage,
  ) {}

  @Post("pipeline-jobs/:cutJobId/transcript-evidence")
  @HttpCode(202)
  @ApiParam({ name: "cutJobId", format: "uuid", type: String })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { type: "string", minLength: 8, maxLength: 200 },
  })
  @ApiBody({ type: CreateTranscriptEvidenceDto })
  @ApiAcceptedResponse({ type: TranscriptEvidenceDto })
  async create(
    @Param("cutJobId", uuid) cutPipelineJobId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateTranscriptEvidenceDto,
  ) {
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey))
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Нужен ключ операции.",
      });
    if (
      !body ||
      !isUuidV4(body.sourceContextRevisionId) ||
      !isUuidV4(body.cutPromptRevisionId) ||
      typeof body.language !== "string" ||
      !body.fixture ||
      typeof body.fixture.language !== "string" ||
      !Array.isArray(body.fixture.segments) ||
      body.fixture.segments.length > 10_000
    )
      throw new BadRequestException({
        code: "TRANSCRIPT_REQUEST_INVALID",
        message:
          "Нужны точные версии контекста и ограниченный transcript fixture.",
      });
    try {
      const id = await this.repository.create({
        cutPipelineJobId,
        sourceContextRevisionId: body.sourceContextRevisionId,
        cutPromptRevisionId: body.cutPromptRevisionId,
        idempotencyKey,
        language: body.language,
        fixture: body.fixture,
      });
      const detail = await this.repository.detail(id);
      if (!detail) throw new NotFoundException();
      await this.dispatch.dispatch({
        schemaVersion: "transcript-job-v1",
        intentId: id,
      });
      return detail;
    } catch (error) {
      throw mapTranscriptError(error);
    }
  }

  @Get("transcript-evidence/:intentId")
  @ApiParam({ name: "intentId", format: "uuid", type: String })
  @ApiNotFoundResponse({ type: TranscriptEvidenceErrorResponseDto })
  @ApiAcceptedResponse({ type: TranscriptEvidenceDto })
  async detail(@Param("intentId", uuid) intentId: string) {
    const value = await this.repository.detail(intentId);
    if (!value) throw new NotFoundException({ code: "TRANSCRIPT_NOT_FOUND" });
    return value;
  }

  @Head("transcript-evidence/:intentId/content")
  async headContent(
    @Param("intentId", uuid) intentId: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    await this.streamContent(intentId, range, response, true);
  }

  @Get("transcript-evidence/:intentId/content")
  async getContent(
    @Param("intentId", uuid) intentId: string,
    @Headers("range") range: string | undefined,
    @Res() response: ServerResponse,
  ): Promise<void> {
    await this.streamContent(intentId, range, response, false);
  }

  private async streamContent(
    intentId: string,
    range: string | undefined,
    response: ServerResponse,
    head: boolean,
  ): Promise<void> {
    const found = await this.repository.content(intentId);
    if (!found)
      throw new NotFoundException({ code: "TRANSCRIPT_CONTENT_NOT_FOUND" });
    if (range && !/^bytes=(\d*)-(\d*)$/.test(range))
      throw new BadRequestException({ code: "RANGE_INVALID" });
    let stored;
    try {
      stored = await this.storage.readObject(found.objectKey, range);
    } catch (error) {
      if (error instanceof ObjectRangeNotSatisfiableError) {
        response.statusCode = 416;
        response.setHeader("Content-Range", `bytes */${found.sizeBytes}`);
        response.end();
        return;
      }
      throw error;
    }
    if (!stored)
      throw new NotFoundException({ code: "TRANSCRIPT_CONTENT_NOT_FOUND" });
    response.statusCode = stored.contentRange ? 206 : 200;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Length", String(stored.contentLength));
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("ETag", `"${found.sha256}"`);
    if (stored.contentRange)
      response.setHeader("Content-Range", stored.contentRange);
    if (head) {
      stored.body.destroy();
      response.end();
      return;
    }
    stored.body.on("error", () => response.destroy());
    response.once("close", () => stored.body.destroy());
    stored.body.pipe(response);
  }
}

function mapTranscriptError(error: unknown): Error {
  if (error instanceof AiContentIdempotencyConflictError)
    return new ConflictException({
      code: "IDEMPOTENCY_CONFLICT",
      message: "Ключ уже использован для другой операции.",
    });
  if (error instanceof TranscriptContextRejectedError)
    return new ConflictException({
      code: "TRANSCRIPT_CONTEXT_REQUIRED",
      message: "Контекст или права источника больше не подходят.",
      blockers: error.blockers,
    });
  return error instanceof Error
    ? error
    : new Error("TRANSCRIPT_REQUEST_FAILED");
}
