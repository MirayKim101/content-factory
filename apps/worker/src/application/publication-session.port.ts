import type { PublicationPlatform } from "@content-factory/contracts";

export interface EncryptedPublicationSession {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string;
}

export interface StoredPublicationSession extends EncryptedPublicationSession {
  publicationIntentId: string;
  platform: PublicationPlatform;
  uploadOffset: bigint;
  expiresAt: Date | null;
}

export interface PublicationSessionRepository {
  save(input: StoredPublicationSession, now: Date): Promise<boolean>;
  load(
    publicationIntentId: string,
    platform: PublicationPlatform,
  ): Promise<StoredPublicationSession | null>;
  advanceOffset(input: {
    publicationIntentId: string;
    platform: PublicationPlatform;
    expectedOffset: bigint;
    nextOffset: bigint;
    now: Date;
  }): Promise<boolean>;
  remove(
    publicationIntentId: string,
    platform: PublicationPlatform,
  ): Promise<void>;
}
