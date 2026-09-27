import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PublicationSessionCipher } from "../src/infrastructure/publication-session-cipher.js";

const intentId = "00000000-0000-4000-8000-000000000001";

describe("PublicationSessionCipher", () => {
  it("round-trips a resumable capability without plaintext persistence", () => {
    const cipher = new PublicationSessionCipher(
      "v2",
      new Map([["v2", randomBytes(32)]]),
    );
    const session = {
      uploadUrl: "https://upload.example/session/secret-capability",
      uploadOffset: 262_144,
    };

    const encrypted = cipher.encrypt({
      publicationIntentId: intentId,
      platform: "YOUTUBE",
      session,
    });

    expect(encrypted.ciphertext.toString("utf8")).not.toContain(
      "upload.example",
    );
    expect(
      cipher.decrypt({
        publicationIntentId: intentId,
        platform: "YOUTUBE",
        ...encrypted,
      }),
    ).toEqual(session);
  });

  it("binds ciphertext to intent and platform and rejects tampering", () => {
    const cipher = new PublicationSessionCipher(
      "v1",
      new Map([["v1", randomBytes(32)]]),
    );
    const encrypted = cipher.encrypt({
      publicationIntentId: intentId,
      platform: "TIKTOK",
      session: { uploadUrl: "https://upload.example/capability" },
    });

    expect(() =>
      cipher.decrypt({
        publicationIntentId: "00000000-0000-4000-8000-000000000002",
        platform: "TIKTOK",
        ...encrypted,
      }),
    ).toThrow("PUBLICATION_SESSION_DECRYPT_FAILED");
    encrypted.ciphertext[0] = (encrypted.ciphertext[0] ?? 0) ^ 1;
    expect(() =>
      cipher.decrypt({
        publicationIntentId: intentId,
        platform: "TIKTOK",
        ...encrypted,
      }),
    ).toThrow("PUBLICATION_SESSION_DECRYPT_FAILED");
  });

  it("decrypts an old key version while encrypting only with the current key", () => {
    const oldKey = randomBytes(32);
    const nextKey = randomBytes(32);
    const oldCipher = new PublicationSessionCipher(
      "v1",
      new Map([["v1", oldKey]]),
    );
    const encrypted = oldCipher.encrypt({
      publicationIntentId: intentId,
      platform: "YOUTUBE",
      session: { uploadUrl: "https://upload.example/old" },
    });
    const rotatingCipher = new PublicationSessionCipher(
      "v2",
      new Map([
        ["v1", oldKey],
        ["v2", nextKey],
      ]),
    );

    expect(
      rotatingCipher.decrypt({
        publicationIntentId: intentId,
        platform: "YOUTUBE",
        ...encrypted,
      }),
    ).toEqual({ uploadUrl: "https://upload.example/old" });
    expect(
      rotatingCipher.encrypt({
        publicationIntentId: intentId,
        platform: "YOUTUBE",
        session: { uploadUrl: "https://upload.example/new" },
      }).keyVersion,
    ).toBe("v2");
  });
});
