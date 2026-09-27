import { describe, expect, it } from "vitest";

import {
  publicationWorkerAdmissionEnabled,
  publicationSessionKeyConfig,
  tiktokPublishingConfig,
  youtubePublishingConfig,
} from "../src/config.js";

describe("publicationWorkerAdmissionEnabled", () => {
  it("is default-off and accepts only the explicit enabled value", () => {
    expect(publicationWorkerAdmissionEnabled({})).toBe(false);
    expect(publicationWorkerAdmissionEnabled({ PUBLISHING_ENABLED: "0" })).toBe(
      false,
    );
    expect(publicationWorkerAdmissionEnabled({ PUBLISHING_ENABLED: "1" })).toBe(
      true,
    );
  });
});

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

describe("tiktokPublishingConfig", () => {
  it("stays disabled without requiring provider secrets", () => {
    expect(
      tiktokPublishingConfig({ TIKTOK_PUBLISHING_ENABLED: "0" }),
    ).toBeNull();
  });

  it("loads bound refresh credentials and shared session keys", () => {
    const config = tiktokPublishingConfig({
      TIKTOK_PUBLISHING_ENABLED: "1",
      TIKTOK_CLIENT_KEY: "client-key",
      TIKTOK_CLIENT_SECRET: "client-secret",
      TIKTOK_CHANNEL_CREDENTIALS_JSON: JSON.stringify([
        {
          externalChannelRef: "723f24d7-e717-40f8-a2b6-cb8464cd23b4",
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
