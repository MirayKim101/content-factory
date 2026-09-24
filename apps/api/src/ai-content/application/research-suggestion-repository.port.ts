import type {
  ResearchSuggestionView,
  TextSuggestion,
} from "@content-factory/contracts";

export const RESEARCH_SUGGESTION_REPOSITORY = Symbol(
  "RESEARCH_SUGGESTION_REPOSITORY",
);

export type ResearchCitationInput = Readonly<{
  url: string;
  title: string;
  publisher: string;
  publishedAt?: string | null;
  excerpt: string;
}>;

export interface ResearchSuggestionClaim {
  intentId: string;
  attemptId: string;
  leaseToken: string;
  workDeadlineAt: Date;
  sourceTitle: string;
  snapshot: ResearchSuggestionView["snapshot"];
}

export interface ResearchSuggestionApplyContext {
  pipelineJobId: string;
  researchIntentId: string;
  suggestionSetId: string;
  suggestion: TextSuggestion;
}

export interface ResearchSuggestionRepository {
  create(input: {
    transcriptIntentId: string;
    idempotencyKey: string;
    query: string;
    citations: readonly ResearchCitationInput[];
  }): Promise<string>;
  detail(intentId: string): Promise<ResearchSuggestionView | null>;
  list(transcriptIntentId: string): Promise<ResearchSuggestionView[]>;
  resolveForApply(intentId: string): Promise<ResearchSuggestionApplyContext>;
  claim(intentId: string): Promise<ResearchSuggestionClaim | null>;
  complete(input: {
    claim: ResearchSuggestionClaim;
    suggestion: TextSuggestion;
  }): Promise<boolean>;
  fail(input: {
    claim: ResearchSuggestionClaim;
    code: string;
    message: string;
  }): Promise<void>;
}

export class ResearchSuggestionContextRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
