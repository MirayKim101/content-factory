import { describe, expect, it } from "vitest";

import {
  API_ENVIRONMENT_KEYS,
  aiContextAdmissionEnabled,
  editorialExportAdmissionEnabled,
  editorialIntegratedReviewAdmissionEnabled,
  publishingAdmissionEnabled,
  resolveClipGenerationRuntime,
  twitchIngestionAdmissionEnabled,
  twitchEventSubSecret,
  verticalRenderAdmissionEnabled,
} from "../src/config/environment.js";

describe("clip generation runtime", () => {
  it("is default-off and exposes both root .env keys to the API loader", () => {
    expect(resolveClipGenerationRuntime({})).toEqual({
      clipGenerationEnabled: false,
      clipGenerationProvider: "OPENAI",
      clipGenerationModel: null,
    });
    expect(
      resolveClipGenerationRuntime({
        CLIP_GENERATION_ENABLED: "1",
        CLIP_GENERATION_MODEL: "gpt-test",
      }),
    ).toEqual({
      clipGenerationEnabled: true,
      clipGenerationProvider: "OPENAI",
      clipGenerationModel: "gpt-test",
    });
    expect(API_ENVIRONMENT_KEYS).toEqual(
      expect.arrayContaining([
        "CLIP_GENERATION_ENABLED",
        "CLIP_GENERATION_PROVIDER",
        "CLIP_GENERATION_MODEL",
      ]),
    );
  });

  it("allows the deterministic fixture only for local deployment", () => {
    expect(() =>
      resolveClipGenerationRuntime(
        { CLIP_GENERATION_PROVIDER: "LOCAL_FIXTURE" },
        "other",
      ),
    ).toThrow("CONFIG_LOCAL_CLIP_PROVIDER_UNSAFE");
    expect(
      resolveClipGenerationRuntime(
        { CLIP_GENERATION_PROVIDER: "LOCAL_FIXTURE" },
        "local",
      ),
    ).toEqual({
      clipGenerationEnabled: false,
      clipGenerationProvider: "LOCAL_FIXTURE",
      clipGenerationModel: "local-deterministic-clip-v1",
    });
  });
});

describe("editorial export rollout flag", () => {
  it.each([
    [{}, false],
    [{ EDITORIAL_EXPORT_ENABLED: "0" }, false],
    [{ EDITORIAL_EXPORT_ENABLED: "1" }, true],
  ] as const)("resolves %o to %s", (environment, expected) => {
    expect(editorialExportAdmissionEnabled(environment)).toBe(expected);
  });
});

describe("publishing rollout flag", () => {
  it.each([
    [{}, false],
    [{ PUBLISHING_ENABLED: "0" }, false],
    [{ PUBLISHING_ENABLED: "1" }, true],
  ] as const)("resolves %o to %s", (environment, expected) => {
    expect(publishingAdmissionEnabled(environment)).toBe(expected);
  });
});

describe("twitch ingestion rollout flag", () => {
  it("is default-off and requires a bounded secret when enabled", () => {
    expect(twitchIngestionAdmissionEnabled({})).toBe(false);
    expect(twitchEventSubSecret({})).toBeNull();
    expect(() =>
      twitchEventSubSecret({ TWITCH_INGESTION_ENABLED: "1" }),
    ).toThrow("CONFIG_TWITCH_EVENTSUB_SECRET_INVALID");
    expect(
      twitchEventSubSecret({
        TWITCH_INGESTION_ENABLED: "1",
        TWITCH_EVENTSUB_SECRET: "0123456789abcdef",
      }),
    ).toBe("0123456789abcdef");
  });
});

describe("vertical rendering rollout flag", () => {
  it.each([
    [{}, false],
    [{ VERTICAL_RENDER_ENABLED: "0" }, false],
    [{ VERTICAL_RENDER_ENABLED: "1" }, true],
  ] as const)("resolves %o to %s", (environment, expected) => {
    expect(verticalRenderAdmissionEnabled(environment)).toBe(expected);
  });
});

describe("creator context rollout flag", () => {
  it.each([
    [{}, false],
    [{ AI_CONTEXT_ENABLED: "0" }, false],
    [{ AI_CONTEXT_ENABLED: "1" }, true],
  ] as const)("resolves %o to %s", (environment, expected) => {
    expect(aiContextAdmissionEnabled(environment)).toBe(expected);
  });
});

describe("integrated editorial review rollout flag", () => {
  it.each([
    [{}, false],
    [{ EDITORIAL_INTEGRATED_REVIEW_ENABLED: "0" }, false],
    [{ EDITORIAL_INTEGRATED_REVIEW_ENABLED: "1" }, true],
  ] as const)("resolves %o to %s", (environment, expected) => {
    expect(editorialIntegratedReviewAdmissionEnabled(environment)).toBe(
      expected,
    );
  });
});
