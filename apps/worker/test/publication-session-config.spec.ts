import { describe, expect, it } from "vitest";

import {
  publicationSessionKeyConfig,
  youtubePublishingConfig,
} from "../src/config.js";

describe("publicationSessionKeyConfig", () => {
  it("loads a current key and retained decryption keys", () => {
    const current = Buffer.alloc(32, 7).toString("base64");
    const previous = Buffer.alloc(32, 8).toString("base64");

    const config = publicationSessionKeyConfig({
      PUBLICATION_SESSION_CURRENT_KEY_VERSION: "v2",
      PUBLICATION_SESSION_KEYS: `v2:${current},v1:${previous}`,
    });

    expect(config.currentKeyVersion).toBe("v2");
    expect(config.keys.get("v1")).toEqual(Buffer.alloc(32, 8));
  });

  it.each([
    {},
    { PUBLICATION_SESSION_CURRENT_KEY_VERSION: "v1" },
    {
      PUBLICATION_SESSION_CURRENT_KEY_VERSION: "v1",
      PUBLICATION_SESSION_KEYS: "v1:not-base64",
    },
    {
      PUBLICATION_SESSION_CURRENT_KEY_VERSION: "v2",
      PUBLICATION_SESSION_KEYS: `v1:${Buffer.alloc(32).toString("base64")}`,
    },
  ])("fails closed for invalid key configuration", (environment) => {
    expect(() => publicationSessionKeyConfig(environment)).toThrow(/^CONFIG_/);
  });
});

describe("youtubePublishingConfig", () => {
  it("does not require secrets while the provider is disabled", () => {
    expect(
      youtubePublishingConfig({ YOUTUBE_PUBLISHING_ENABLED: "0" }),
    ).toBeNull();
  });

  it("loads exact channel bindings only when enabled", () => {
    const config = youtubePublishingConfig({
      YOUTUBE_PUBLISHING_ENABLED: "1",
      YOUTUBE_OAUTH_CLIENT_ID: "client-id",
      YOUTUBE_OAUTH_CLIENT_SECRET: "client-secret",
      YOUTUBE_CHANNEL_CREDENTIALS_JSON: JSON.stringify([
        {
          channelId: "00000000-0000-4000-8000-000000000001",
          externalChannelRef: "UC1234567890123456789012",
          refreshToken: "refresh-token",
        },
      ]),
      PUBLICATION_SESSION_CURRENT_KEY_VERSION: "v1",
      PUBLICATION_SESSION_KEYS: `v1:${Buffer.alloc(32, 9).toString("base64")}`,
    });

    expect(config?.credentials).toHaveLength(1);
    expect(config?.keys.get("v1")).toEqual(Buffer.alloc(32, 9));
  });
});
