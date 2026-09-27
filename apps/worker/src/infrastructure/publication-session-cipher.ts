import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { PublicationPlatform } from "@content-factory/contracts";

import type { EncryptedPublicationSession } from "../application/publication-session.port.js";

const MAX_PLAINTEXT_BYTES = 8 * 1024;

export class PublicationSessionCipher {
  constructor(
    private readonly currentKeyVersion: string,
    private readonly keys: ReadonlyMap<string, Buffer>,
  ) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(currentKeyVersion))
      throw new Error("PUBLICATION_SESSION_KEY_VERSION_INVALID");
    if (!keys.has(currentKeyVersion))
      throw new Error("PUBLICATION_SESSION_CURRENT_KEY_MISSING");
    for (const key of keys.values())
      if (key.length !== 32) throw new Error("PUBLICATION_SESSION_KEY_INVALID");
  }

  encrypt(input: {
    publicationIntentId: string;
    platform: PublicationPlatform;
    session: Record<string, unknown>;
  }): EncryptedPublicationSession {
    const plaintext = Buffer.from(JSON.stringify(input.session), "utf8");
    if (!plaintext.length || plaintext.length > MAX_PLAINTEXT_BYTES)
      throw new Error("PUBLICATION_SESSION_PAYLOAD_INVALID");
    const iv = randomBytes(12);
    const key = this.keys.get(this.currentKeyVersion)!;
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(this.aad(input, this.currentKeyVersion));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return {
      ciphertext,
      iv,
      authTag: cipher.getAuthTag(),
      keyVersion: this.currentKeyVersion,
    };
  }

  decrypt(
    input: {
      publicationIntentId: string;
      platform: PublicationPlatform;
    } & EncryptedPublicationSession,
  ): Record<string, unknown> {
    const key = this.keys.get(input.keyVersion);
    if (!key) throw new Error("PUBLICATION_SESSION_KEY_UNAVAILABLE");
    if (
      input.iv.length !== 12 ||
      input.authTag.length !== 16 ||
      !input.ciphertext.length ||
      input.ciphertext.length > MAX_PLAINTEXT_BYTES + 16
    )
      throw new Error("PUBLICATION_SESSION_ENVELOPE_INVALID");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, input.iv);
      decipher.setAAD(this.aad(input, input.keyVersion));
      decipher.setAuthTag(input.authTag);
      const plaintext = Buffer.concat([
        decipher.update(input.ciphertext),
        decipher.final(),
      ]);
      const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("PUBLICATION_SESSION_PAYLOAD_INVALID");
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PUBLICATION_SESSION_PAYLOAD_INVALID"
      )
        throw error;
      throw new Error("PUBLICATION_SESSION_DECRYPT_FAILED");
    }
  }

  private aad(
    input: { publicationIntentId: string; platform: PublicationPlatform },
    keyVersion: string,
  ): Buffer {
    return Buffer.from(
      `publication-session-v1\0${input.publicationIntentId}\0${input.platform}\0${keyVersion}`,
      "utf8",
    );
  }
}
