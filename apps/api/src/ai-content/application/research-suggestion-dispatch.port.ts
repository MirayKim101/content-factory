export const RESEARCH_SUGGESTION_DISPATCH = Symbol(
  "RESEARCH_SUGGESTION_DISPATCH",
);

export const RESEARCH_JOB_SCHEMA_VERSION =
  "research-suggestion-job-v1" as const;

export type ResearchSuggestionDeliveryV1 = Readonly<{
  schemaVersion: typeof RESEARCH_JOB_SCHEMA_VERSION;
  intentId: string;
}>;

export interface ResearchSuggestionDispatch {
  dispatch(delivery: ResearchSuggestionDeliveryV1): Promise<void>;
}
