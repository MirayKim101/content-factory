export const IMAGE_SUGGESTION_DISPATCH = Symbol("IMAGE_SUGGESTION_DISPATCH");
export const IMAGE_SUGGESTION_JOB_SCHEMA_VERSION = "ai-image-suggestion-job-v1";

export interface ImageSuggestionDispatch {
  dispatch(input: {
    schemaVersion: typeof IMAGE_SUGGESTION_JOB_SCHEMA_VERSION;
    intentId: string;
  }): Promise<void>;
}
