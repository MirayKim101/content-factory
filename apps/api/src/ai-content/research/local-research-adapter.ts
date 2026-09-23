import {
  LOCAL_RESEARCH_ADAPTER_VERSION,
  RESEARCH_CONTRACT_VERSION,
  validateResearchSnapshot,
  type ResearchSnapshot,
  type TextSuggestion,
} from "@content-factory/contracts";

/** Deterministic offline adapter used until a provider is explicitly approved. */
export class LocalResearchAdapter {
  readonly version = LOCAL_RESEARCH_ADAPTER_VERSION;

  suggest(input: {
    snapshot: ResearchSnapshot;
    sourceTitle: string;
  }): TextSuggestion {
    validateResearchSnapshot(input.snapshot);
    const title = input.sourceTitle.trim();
    if (!title) throw new Error("RESEARCH_SOURCE_TITLE_REQUIRED");
    return {
      title: title.slice(0, 120),
      description: `Ручная AI-заготовка по теме «${input.snapshot.query.slice(0, 180)}». Проверьте факты и отредактируйте перед экспортом.`,
      tags: input.snapshot.citations.slice(0, 8).map((citation) => citation.publisher),
      basisVersion: `${RESEARCH_CONTRACT_VERSION}:${input.snapshot.adapterVersion}`,
      mode: "AI_ASSISTED",
    };
  }
}
