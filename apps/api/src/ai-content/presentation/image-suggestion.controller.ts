import type { ServerResponse } from "node:http";

import { BadRequestException, ConflictException, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Res, ServiceUnavailableException, Body } from "@nestjs/common";
import { ApiAcceptedResponse, ApiBody, ApiHeader, ApiOkResponse, ApiParam, ApiProduces, ApiTags } from "@nestjs/swagger";

import { apiEnvironment } from "../../config/environment.js";
import { OBJECT_STORAGE, ObjectRangeNotSatisfiableError, type ObjectStorage } from "../../projects/application/object-storage.port.js";
import { AiContentIdempotencyConflictError } from "../application/creator-context-repository.port.js";
import { IMAGE_SUGGESTION_DISPATCH, IMAGE_SUGGESTION_JOB_SCHEMA_VERSION, type ImageSuggestionDispatch } from "../application/image-suggestion-dispatch.port.js";
import { IMAGE_SUGGESTION_REPOSITORY, ImageSuggestionContextRejectedError, type ImageSuggestionRepository } from "../application/image-suggestion-repository.port.js";
import { CreateImageSuggestionDto, ImageSuggestionListResponseDto, ImageSuggestionResponseDto } from "./image-suggestion.dto.js";
import { ApplyImageSuggestionDto, ImageSuggestionApplyResponseDto } from "./image-suggestion.dto.js";
import { ApplyImageSuggestion } from "../application/apply-image-suggestion.js";
import { EditorialIdempotencyConflictError, EditorialRevisionConflictError } from "../../editorial-content/application/editorial-repository.port.js";

@ApiTags("thumbnail-suggestions")
@Controller("api/v1")
export class ImageSuggestionController {
  constructor(
    @Inject(IMAGE_SUGGESTION_REPOSITORY) private readonly repository: ImageSuggestionRepository,
    @Inject(IMAGE_SUGGESTION_DISPATCH) private readonly dispatch: ImageSuggestionDispatch,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly applyImage: ApplyImageSuggestion,
  ) {}

  @Post("projects/:projectId/pipeline-jobs/:cutJobId/image-suggestions")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam({ name: "projectId", format: "uuid" })
  @ApiParam({ name: "cutJobId", format: "uuid" })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreateImageSuggestionDto })
  @ApiAcceptedResponse({ type: ImageSuggestionResponseDto })
  async create(
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Param("cutJobId", new ParseUUIDPipe({ version: "4" })) cutJobId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateImageSuggestionDto,
  ) {
    this.requireEnabled();
    try {
      const id = await this.repository.create({ projectId, cutPipelineJobId: cutJobId, sourceContextRevisionId: body.sourceContextRevisionId, cutPromptRevisionId: body.cutPromptRevisionId, idempotencyKey: requireKey(idempotencyKey) });
      const detail = await this.repository.detail(id);
      if (!detail || detail.projectId !== projectId) throw new NotFoundException({ code: "IMAGE_SUGGESTION_NOT_FOUND" });
      await this.dispatch.dispatch({ schemaVersion: IMAGE_SUGGESTION_JOB_SCHEMA_VERSION, intentId: id });
      return detail;
    } catch (error) { this.rethrow(error); }
  }

  @Get("projects/:projectId/pipeline-jobs/:cutJobId/image-suggestions")
  @ApiOkResponse({ type: ImageSuggestionListResponseDto })
  async list(@Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string, @Param("cutJobId", new ParseUUIDPipe({ version: "4" })) cutJobId: string) {
    this.requireEnabled();
    return { items: (await this.repository.list(cutJobId)).filter((item) => item.projectId === projectId) };
  }

  @Get("projects/:projectId/pipeline-jobs/:cutJobId/image-suggestions/:intentId")
  @ApiOkResponse({ type: ImageSuggestionResponseDto })
  async detail(@Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string, @Param("cutJobId", new ParseUUIDPipe({ version: "4" })) cutJobId: string, @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string) {
    this.requireEnabled();
    const detail = await this.repository.detail(intentId);
    if (!detail || detail.projectId !== projectId || detail.cutPipelineJobId !== cutJobId) throw new NotFoundException({ code: "IMAGE_SUGGESTION_NOT_FOUND" });
    return detail;
  }

  @Get("projects/:projectId/pipeline-jobs/:cutJobId/image-suggestions/:intentId/candidates/:candidateId/content")
  @ApiProduces("image/png")
  async content(@Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string, @Param("cutJobId", new ParseUUIDPipe({ version: "4" })) cutJobId: string, @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string, @Param("candidateId", new ParseUUIDPipe({ version: "4" })) candidateId: string, @Headers("range") range: string | undefined, @Res() response: ServerResponse): Promise<void> {
    this.requireEnabled();
    try {
      const detail = await this.repository.detail(intentId);
      const found = await this.repository.resolveContent(intentId, candidateId);
      if (!detail || detail.projectId !== projectId || detail.cutPipelineJobId !== cutJobId || !found) throw new NotFoundException({ code: "IMAGE_CANDIDATE_NOT_FOUND" });
      const size = Number(found.sizeBytes);
      if (!Number.isSafeInteger(size) || size <= 0) throw new HttpException({ code: "IMAGE_CANDIDATE_INVALID" }, 503);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, no-store");
      const interval = parseImageRange(range, size);
      if (!interval) {
        response.setHeader("Content-Range", `bytes */${size}`);
        throw new HttpException({ code: "RANGE_NOT_SATISFIABLE" }, 416);
      }
      const metadata = await this.storage.headObject(found.objectKey);
      if (!metadata) throw new NotFoundException({ code: "IMAGE_CANDIDATE_OBJECT_NOT_FOUND" });
      if (metadata.sizeBytes !== size || metadata.sha256 !== found.sha256) throw new HttpException({ code: "IMAGE_CANDIDATE_INVALID" }, 503);
      const stored = await this.storage.readObject?.(found.objectKey, range === undefined ? undefined : `bytes=${interval.start}-${interval.end}`);
      if (!stored) throw new NotFoundException({ code: "IMAGE_CANDIDATE_OBJECT_NOT_FOUND" });
      const expectedLength = interval.end - interval.start + 1;
      if (stored.contentLength !== expectedLength) { stored.body.destroy(); throw new HttpException({ code: "IMAGE_CANDIDATE_INVALID" }, 503); }
      response.statusCode = range === undefined ? 200 : 206;
      response.setHeader("Content-Type", "image/png");
      response.setHeader("Content-Length", String(expectedLength));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("ETag", `"${found.sha256}"`);
      response.setHeader("Content-Disposition", `inline; filename="thumbnail-${candidateId}.png"`);
      if (range !== undefined) response.setHeader("Content-Range", `bytes ${interval.start}-${interval.end}/${size}`);
      stored.body.on("error", () => response.destroy());
      response.once("close", () => stored.body.destroy());
      stored.body.pipe(response);
    } catch (error) {
      if (!response.headersSent) { response.removeHeader("Content-Length"); response.removeHeader("Content-Type"); }
      if (error instanceof ObjectRangeNotSatisfiableError) throw new HttpException({ code: "RANGE_NOT_SATISFIABLE" }, 416);
      if (error instanceof ImageSuggestionContextRejectedError) this.rethrow(error);
      throw error;
    }
  }

  @Post("projects/:projectId/pipeline-jobs/:cutJobId/image-suggestions/:intentId/apply")
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: ApplyImageSuggestionDto })
  @ApiOkResponse({ type: ImageSuggestionApplyResponseDto })
  async apply(@Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string, @Param("cutJobId", new ParseUUIDPipe({ version: "4" })) cutJobId: string, @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string, @Headers("idempotency-key") idempotencyKey: string | undefined, @Body() body: ApplyImageSuggestionDto) {
    this.requireEnabled();
    try {
      const detail = await this.repository.detail(intentId);
      if (!detail || detail.projectId !== projectId || detail.cutPipelineJobId !== cutJobId) throw new NotFoundException({ code: "IMAGE_SUGGESTION_NOT_FOUND" });
      const result = await this.applyImage.execute({ imageIntentId: intentId, expectedEditorialRevision: body.expectedEditorialRevision, idempotencyKey: requireKey(idempotencyKey) });
      if (!result.revision.thumbnail) throw new ConflictException({ code: "IMAGE_APPLY_FAILED" });
      return { packageId: result.id, packageRevisionId: result.revision.id, revision: result.revision.revision, thumbnailAssetId: result.revision.thumbnail.id, thumbnailMode: "AI_ASSISTED" as const };
    } catch (error) { this.rethrow(error); }
  }

  private requireEnabled() { if (!apiEnvironment().thumbnailSuggestionsEnabled) throw new ServiceUnavailableException({ code: "THUMBNAIL_SUGGESTIONS_DISABLED" }); }
  private rethrow(error: unknown): never {
    if (error instanceof AiContentIdempotencyConflictError) throw new ConflictException({ code: "AI_CONTENT_IDEMPOTENCY_CONFLICT" });
    if (error instanceof ImageSuggestionContextRejectedError) throw new ConflictException({ code: error.code });
    if (error instanceof EditorialIdempotencyConflictError) throw new ConflictException({ code: "EDITORIAL_IDEMPOTENCY_CONFLICT" });
    if (error instanceof EditorialRevisionConflictError) throw new ConflictException({ code: "EDITORIAL_REVISION_CONFLICT" });
    throw error;
  }
}

export function parseImageRange(range: string | undefined, size: number): { start: number; end: number } | null {
  if (range === undefined) return { start: 0, end: size - 1 };
  if (range.length > 100) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function requireKey(value: string | undefined): string {
  const key = value?.trim(); if (!key || key.length > 200) throw new BadRequestException({ code: "IDEMPOTENCY_KEY_REQUIRED" }); return key;
}
