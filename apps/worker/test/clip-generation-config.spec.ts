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

  it.each([
    "not-a-url",
    "http://gateway.example.test",
    "https://user:password@gateway.example.test",
    "https://gateway.example.test?token=secret",
    "https://gateway.example.test#fragment",
  ])("rejects an invalid or unsafe OpenAI base URL: %s", (baseUrl) => {
    expect(() =>
      openAiClipGenerationConfig({
        CLIP_GENERATION_ENABLED: "1",
        OPENAI_API_KEY: "secret",
        CLIP_GENERATION_MODEL: "gpt-test",
        OPENAI_BASE_URL: baseUrl,
      }),
    ).toThrow(/CONFIG_OPENAI_BASE_URL_(?:INVALID|UNSAFE)/);
  });

  it("allows local HTTP only in the explicit local deployment profile", () => {
    expect(
      openAiClipGenerationConfig({
        CLIP_GENERATION_ENABLED: "1",
        OPENAI_API_KEY: "secret",
        CLIP_GENERATION_MODEL: "gpt-test",
        OPENAI_BASE_URL: "http://127.0.0.1:8080/",
        DEPLOYMENT_PROFILE: "local",
      }),
    ).toMatchObject({ baseUrl: "http://127.0.0.1:8080" });
  });
});
