import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import {
  TRANSCRIPT_EVIDENCE_REPOSITORY,
  type TranscriptEvidenceRepository,
} from "../application/transcript-evidence-repository.port.js";
import { LocalResearchAdapter } from "./local-research-adapter.js";
import { CreateResearchSuggestionDto } from "./research.dto.js";

@ApiTags("research-text")
@Controller("api/v1")
export class ResearchController {
  private readonly adapter = new LocalResearchAdapter();

  constructor(
    @Inject(TRANSCRIPT_EVIDENCE_REPOSITORY)
    private readonly transcriptRepository: TranscriptEvidenceRepository,
  ) {}

  @Post("transcript-evidence/:intentId/research-suggestions")
  @ApiParam({ name: "intentId", format: "uuid", type: String })
  @ApiBody({ type: CreateResearchSuggestionDto })
  @ApiAcceptedResponse({ description: "Deterministic cited local suggestion." })
  async suggest(
    @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string,
    @Body() body: CreateResearchSuggestionDto,
  ) {
    const evidence = await this.transcriptRepository.detail(intentId);
    if (!evidence)
      throw new NotFoundException({ code: "TRANSCRIPT_NOT_FOUND" });
    try {
      return {
        intentId,
        snapshot: {
          contractVersion: "editorial-research-v1",
          adapterVersion: "local-manual-research-v1",
          query: body.query,
          freshness: "CURRENT" as const,
          citations: body.citations,
        },
        suggestion: this.adapter.suggest({
          sourceTitle: body.sourceTitle,
          snapshot: {
            contractVersion: "editorial-research-v1",
            adapterVersion: "local-manual-research-v1",
            query: body.query,
            freshness: "CURRENT",
            citations: body.citations,
          },
        }),
      };
    } catch (error) {
      throw new BadRequestException({
        code:
          error instanceof Error ? error.message : "RESEARCH_REQUEST_INVALID",
        message: "Исследовательский ввод не прошёл проверку.",
      });
    }
  }
}
