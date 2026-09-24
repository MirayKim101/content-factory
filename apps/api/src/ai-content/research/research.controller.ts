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
import { createHash, randomUUID } from "node:crypto";
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
import { ResearchSuggestionResponseDto } from "./research-response.dto.js";

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
  @ApiAcceptedResponse({
    description: "Deterministic cited local suggestion.",
    type: ResearchSuggestionResponseDto,
  })
  async suggest(
    @Param("intentId", new ParseUUIDPipe({ version: "4" })) intentId: string,
    @Body() body: CreateResearchSuggestionDto,
  ) {
    const evidence = await this.transcriptRepository.detail(intentId);
    if (!evidence)
      throw new NotFoundException({ code: "TRANSCRIPT_NOT_FOUND" });
    try {
      const snapshot = {
        contractVersion: "editorial-research-v1" as const,
        adapterVersion: "local-manual-research-v1",
        query: body.query,
        freshness: "CURRENT" as const,
        citations: body.citations.map((citation) => ({
          id: randomUUID(),
          url: citation.url,
          title: citation.title,
          publisher: citation.publisher,
          publishedAt: citation.publishedAt ?? null,
          accessedAt: citation.accessedAt,
          excerpt: citation.excerpt,
          checksum: createHash("sha256").update(citation.excerpt).digest("hex"),
        })),
      };
      return {
        intentId,
        snapshot,
        suggestion: this.adapter.suggest({
          sourceTitle: body.sourceTitle,
          snapshot,
          suggestionId: randomUUID(),
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
