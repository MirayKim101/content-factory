import { describe, expect, it } from "vitest";

import {
  twitchEventSubSecretVersion,
  twitchVodAutoIngestConfig,
  twitchVodMediaGatewayConfig,
} from "../src/config.js";

describe("twitchEventSubSecretVersion", () => {
  it("requires callback, secret and an explicit rotation version together", () => {
    expect(twitchEventSubSecretVersion({})).toBeNull();
    expect(() =>
      twitchEventSubSecretVersion({
        TWITCH_EVENTSUB_CALLBACK_URL:
          "https://content.example.test/api/v1/twitch/eventsub",
        TWITCH_EVENTSUB_SECRET: "secret",
      }),
    ).toThrow("CONFIG_TWITCH_EVENTSUB_CALLBACK_SECRET_AND_VERSION_REQUIRED");
    expect(
      twitchEventSubSecretVersion({
        TWITCH_EVENTSUB_CALLBACK_URL:
          "https://content.example.test/api/v1/twitch/eventsub",
        TWITCH_EVENTSUB_SECRET: "secret",
        TWITCH_EVENTSUB_SECRET_VERSION: "rotation-2026-10",
      }),
    ).toBe("rotation-2026-10");
  });

  it("rejects versions that are unsafe for durable comparison", () => {
    expect(() =>
      twitchEventSubSecretVersion({
        TWITCH_EVENTSUB_CALLBACK_URL:
          "https://content.example.test/api/v1/twitch/eventsub",
        TWITCH_EVENTSUB_SECRET: "secret",
        TWITCH_EVENTSUB_SECRET_VERSION: "bad version",
      }),
    ).toThrow("CONFIG_TWITCH_EVENTSUB_SECRET_VERSION_INVALID");
  });
});

describe("twitchVodMediaGatewayConfig", () => {
  it("is default-off and requires secrets only when enabled", () => {
    expect(twitchVodMediaGatewayConfig({})).toBeNull();
    expect(() =>
      twitchVodMediaGatewayConfig({ TWITCH_VOD_MEDIA_GATEWAY_ENABLED: "1" }),
    ).toThrow("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_BASE_URL_REQUIRED");
  });

  it("requires HTTPS outside local loopback development", () => {
    expect(() =>
      twitchVodMediaGatewayConfig({
        TWITCH_VOD_MEDIA_GATEWAY_ENABLED: "1",
        TWITCH_VOD_MEDIA_GATEWAY_BASE_URL: "http://media.example.test",
        TWITCH_VOD_MEDIA_GATEWAY_TOKEN: "secret",
      }),
    ).toThrow("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_BASE_URL_UNSAFE");
    expect(
      twitchVodMediaGatewayConfig({
        TWITCH_VOD_MEDIA_GATEWAY_ENABLED: "1",
        TWITCH_VOD_MEDIA_GATEWAY_BASE_URL: "http://127.0.0.1:9999/",
        TWITCH_VOD_MEDIA_GATEWAY_TOKEN: "secret",
        DEPLOYMENT_PROFILE: "local",
      }),
    ).toMatchObject({ baseUrl: "http://127.0.0.1:9999" });
  });

  it("accepts only a fixed origin and a header-safe bearer token", () => {
    expect(() =>
      twitchVodMediaGatewayConfig({
        TWITCH_VOD_MEDIA_GATEWAY_ENABLED: "1",
        TWITCH_VOD_MEDIA_GATEWAY_BASE_URL:
          "https://media.example.test/proxy-prefix",
        TWITCH_VOD_MEDIA_GATEWAY_TOKEN: "secret",
      }),
    ).toThrow("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_BASE_URL_UNSAFE");
    expect(() =>
      twitchVodMediaGatewayConfig({
        TWITCH_VOD_MEDIA_GATEWAY_ENABLED: "1",
        TWITCH_VOD_MEDIA_GATEWAY_BASE_URL: "https://media.example.test",
        TWITCH_VOD_MEDIA_GATEWAY_TOKEN: "secret\nsecond-header: injected",
      }),
    ).toThrow("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_TOKEN_INVALID");
    expect(
      twitchVodMediaGatewayConfig({
        TWITCH_VOD_MEDIA_GATEWAY_ENABLED: "1",
        TWITCH_VOD_MEDIA_GATEWAY_BASE_URL: "https://media.example.test/",
        TWITCH_VOD_MEDIA_GATEWAY_TOKEN: "header-safe_secret.token",
      }),
    ).toMatchObject({
      baseUrl: "https://media.example.test",
      bearerToken: "header-safe_secret.token",
    });
  });
});

describe("twitchVodAutoIngestConfig", () => {
  it("keeps the worker data plane off unless its dedicated gate is enabled", () => {
    expect(
      twitchVodAutoIngestConfig({
        TWITCH_VOD_MEDIA_GATEWAY_ENABLED: "1",
        TWITCH_VOD_MEDIA_GATEWAY_BASE_URL: "https://media.example.test",
        TWITCH_VOD_MEDIA_GATEWAY_TOKEN: "secret",
      }),
    ).toBeNull();
  });

  it("requires the media gateway gate and configuration when auto ingest is enabled", () => {
    expect(() =>
      twitchVodAutoIngestConfig({ TWITCH_VOD_AUTO_INGEST_ENABLED: "1" }),
    ).toThrow("CONFIG_TWITCH_VOD_MEDIA_GATEWAY_REQUIRED");
    expect(
      twitchVodAutoIngestConfig({
        TWITCH_VOD_AUTO_INGEST_ENABLED: "1",
        TWITCH_VOD_MEDIA_GATEWAY_ENABLED: "1",
        TWITCH_VOD_MEDIA_GATEWAY_BASE_URL: "https://media.example.test",
        TWITCH_VOD_MEDIA_GATEWAY_TOKEN: "secret",
      }),
    ).toMatchObject({ baseUrl: "https://media.example.test" });
  });
});
