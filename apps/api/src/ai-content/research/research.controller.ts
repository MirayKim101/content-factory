import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";

import { apiEnvironment } from "../../config/environment.js";
import {
  EditorialIdempotencyConflictError,
  EditorialRevisionConflictError,
} from "../../editorial-content/application/editorial-repository.port.js";
import { ApplyResearchMetadata } from "../application/apply-research-metadata.js";
import { AiContentIdempotencyConflictError } from "../application/creator-context-repository.port.js";
import {
  RESEARCH_JOB_SCHEMA_VERSION,
  RESEARCH_SUGGESTION_DISPATCH,
  type ResearchSuggestionDispatch,
} from "../application/research-suggestion-dispatch.port.js";
import {
  RESEARCH_SUGGESTION_REPOSITORY,
  ResearchSuggestionContextRejectedError,
  type ResearchSuggestionRepository,
} from "../application/research-suggestion-repository.port.js";
import {
  ApplyResearchMetadataDto,
  CreateResearchSuggestionDto,
} from "./research.dto.js";
import {
  ResearchMetadataApplyResponseDto,
  ResearchSuggestionListResponseDto,
  ResearchSuggestionResponseDto,
} from "./research-response.dto.js";

@ApiTags("research-text")
@Controller("api/v1")
export class ResearchController {
  constructor(
    @Inject(RESEARCH_SUGGESTION_REPOSITORY)
    private readonly repository: ResearchSuggestionRepository,
    @Inject(RESEARCH_SUGGESTION_DISPATCH)
    private readonly dispatch: ResearchSuggestionDispatch,
    private readonly applyMetadata: ApplyResearchMetadata,
  ) {}

  @Post("transcript-evidence/:intentId/research-suggestions")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam({ name: "intentId", format: "uuid", type: String })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: CreateResearchSuggestionDto })
  @ApiAcceptedResponse({ type: ResearchSuggestionResponseDto })
  async create(
    @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CreateResearchSuggestionDto,
  ) {
    this.requireEnabled();
    try {
      const researchIntentId = await this.repository.create({
        transcriptIntentId: intentId,
        idempotencyKey: requireIdempotencyKey(idempotencyKey),
        query: body.query,
        citations: body.citations,
      });
      await this.dispatch.dispatch({
        schemaVersion: RESEARCH_JOB_SCHEMA_VERSION,
        intentId: researchIntentId,
      });
      const detail = await this.repository.detail(researchIntentId);
      if (!detail) throw new NotFoundException();
      return detail;
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Get("transcript-evidence/:intentId/research-suggestions")
  @ApiParam({ name: "intentId", format: "uuid", type: String })
  @ApiOkResponse({ type: ResearchSuggestionListResponseDto })
  async list(
    @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string,
  ) {
    this.requireEnabled();
    return { items: await this.repository.list(intentId) };
  }

  @Get("research-suggestions/:researchIntentId")
  @ApiParam({ name: "researchIntentId", format: "uuid", type: String })
  @ApiOkResponse({ type: ResearchSuggestionResponseDto })
  async detail(
    @Param("researchIntentId", new ParseUUIDPipe({ version: "4" }))
    researchIntentId: string,
  ) {
    this.requireEnabled();
    const detail = await this.repository.detail(researchIntentId);
    if (!detail)
      throw new NotFoundException({ code: "RESEARCH_SUGGESTION_NOT_FOUND" });
    return detail;
  }

  @Post("research-suggestions/:researchIntentId/apply-metadata")
  @ApiParam({ name: "researchIntentId", format: "uuid", type: String })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiBody({ type: ApplyResearchMetadataDto })
  @ApiOkResponse({ type: ResearchMetadataApplyResponseDto })
  async apply(
    @Param("researchIntentId", new ParseUUIDPipe({ version: "4" }))
    researchIntentId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: ApplyResearchMetadataDto,
  ): Promise<ResearchMetadataApplyResponseDto> {
    this.requireEnabled();
    try {
      const result = await this.applyMetadata.execute({
        researchIntentId,
        idempotencyKey: requireIdempotencyKey(idempotencyKey),
        ...body,
      });
      return {
        packageId: result.id,
        packageRevisionId: result.revision.id,
        revision: result.revision.revision,
        title: result.revision.title ?? "",
        description: result.revision.description ?? "",
        tags: result.revision.tags ?? [],
        metadataMode: result.revision.provenance.metadata.mode as
          "AI_ASSISTED" | "MIXED",
        thumbnailAssetId: result.revision.thumbnail?.id ?? null,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private requireEnabled(): void {
    if (!apiEnvironment().researchTextEnabled)
      throw new ServiceUnavailableException({ code: "RESEARCH_TEXT_DISABLED" });
  }

  private rethrow(error: unknown): never {
    if (error instanceof AiContentIdempotencyConflictError)
      throw new ConflictException({ code: "AI_CONTENT_IDEMPOTENCY_CONFLICT" });
    if (error instanceof EditorialIdempotencyConflictError)
      throw new ConflictException({ code: "EDITORIAL_IDEMPOTENCY_CONFLICT" });
    if (error instanceof EditorialRevisionConflictError)
      throw new ConflictException({ code: "EDITORIAL_REVISION_CONFLICT" });
    if (error instanceof ResearchSuggestionContextRejectedError)
      throw new ConflictException({ code: error.code });
    throw error;
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length > 200)
    throw new BadRequestException({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  return key;
}
