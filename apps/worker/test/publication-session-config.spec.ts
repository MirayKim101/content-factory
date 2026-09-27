import { describe, expect, it } from "vitest";

import { publicationSessionKeyConfig } from "../src/config.js";

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
