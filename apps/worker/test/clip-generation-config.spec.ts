import { describe, expect, it } from "vitest";

import { openAiClipGenerationConfig } from "../src/config.js";

describe("openAiClipGenerationConfig", () => {
  it("is disabled by default without requiring secrets", () => {
    expect(openAiClipGenerationConfig({})).toBeNull();
  });

  it("requires an explicit model and key when enabled", () => {
    expect(() =>
      openAiClipGenerationConfig({ CLIP_GENERATION_ENABLED: "1" }),
    ).toThrow("CONFIG_OPENAI_API_KEY_REQUIRED");
    expect(() =>
      openAiClipGenerationConfig({
        CLIP_GENERATION_ENABLED: "1",
        OPENAI_API_KEY: "secret",
      }),
    ).toThrow("CONFIG_CLIP_GENERATION_MODEL_REQUIRED");
  });

  it("builds a bounded OpenAI configuration", () => {
    expect(
      openAiClipGenerationConfig({
        CLIP_GENERATION_ENABLED: "1",
        CLIP_GENERATION_PROVIDER: "OPENAI",
        OPENAI_API_KEY: "secret",
        CLIP_GENERATION_MODEL: "gpt-test",
        CLIP_GENERATION_TIMEOUT_MS: "45000",
        OPENAI_BASE_URL: "https://gateway.example.test",
      }),
    ).toEqual({
      apiKey: "secret",
      model: "gpt-test",
      timeoutMs: 45_000,
      baseUrl: "https://gateway.example.test",
    });
  });

  it("rejects unsupported providers and unsafe timeouts", () => {
    expect(() =>
      openAiClipGenerationConfig({
        CLIP_GENERATION_ENABLED: "1",
        CLIP_GENERATION_PROVIDER: "UNKNOWN",
      }),
    ).toThrow("CONFIG_CLIP_GENERATION_PROVIDER_UNSUPPORTED");
    expect(() =>
      openAiClipGenerationConfig({
        CLIP_GENERATION_ENABLED: "1",
        OPENAI_API_KEY: "secret",
        CLIP_GENERATION_MODEL: "gpt-test",
        CLIP_GENERATION_TIMEOUT_MS: "1000",
      }),
    ).toThrow("CONFIG_CLIP_GENERATION_TIMEOUT_MS_INVALID");
  });
});
