import { describe, expect, it } from "vitest";

import { twitchVodMediaGatewayConfig } from "../src/config.js";

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
});
