import { Pool } from "pg";
import { workerPgPoolConfig } from "./worker-pg-pool.js";

import type {
  PublicationSessionRepository,
  StoredPublicationSession,
} from "../application/publication-session.port.js";

type SessionRow = {
  publicationIntentId: string;
  platform: StoredPublicationSession["platform"];
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string;
  uploadOffset: string;
  expiresAt: Date | null;
};

export class PgPublicationSessionRepository implements PublicationSessionRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool(workerPgPoolConfig(databaseUrl, 2));
  }

  async save(input: StoredPublicationSession, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO "PublicationProviderSession"
         ("publicationIntentId", "platform", "ciphertext", "iv", "authTag",
          "keyVersion", "uploadOffset", "expiresAt", "createdAt", "updatedAt")
       SELECT i."id", i."platform", $3, $4, $5, $6, $7, $8, $9, $9
         FROM "PublicationIntent" i
        WHERE i."id" = $1 AND i."platform" = $2
          AND i."state" IN ('PROCESSING', 'UNKNOWN_REMOTE_STATE')
       ON CONFLICT ("publicationIntentId") DO UPDATE
         SET "ciphertext" = EXCLUDED."ciphertext", "iv" = EXCLUDED."iv",
             "authTag" = EXCLUDED."authTag", "keyVersion" = EXCLUDED."keyVersion",
             "uploadOffset" = EXCLUDED."uploadOffset",
             "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt"
         WHERE "PublicationProviderSession"."platform" = EXCLUDED."platform"`,
      [
        input.publicationIntentId,
        input.platform,
        input.ciphertext,
        input.iv,
        input.authTag,
        input.keyVersion,
        input.uploadOffset.toString(),
        input.expiresAt,
        now,
      ],
    );
    return result.rowCount === 1;
  }

  async load(
    publicationIntentId: string,
    platform: StoredPublicationSession["platform"],
  ): Promise<StoredPublicationSession | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT s."publicationIntentId", s."platform", s."ciphertext", s."iv",
              s."authTag", s."keyVersion", s."uploadOffset"::text, s."expiresAt"
         FROM "PublicationProviderSession" s
         JOIN "PublicationIntent" i ON i."id" = s."publicationIntentId"
                                   AND i."platform" = s."platform"
        WHERE s."publicationIntentId" = $1 AND s."platform" = $2
          AND (s."expiresAt" IS NULL OR s."expiresAt" > now())
          AND i."state" IN ('PROCESSING', 'UNKNOWN_REMOTE_STATE')`,
      [publicationIntentId, platform],
    );
    const row = result.rows[0];
    return row ? { ...row, uploadOffset: BigInt(row.uploadOffset) } : null;
  }

  async advanceOffset(input: {
    publicationIntentId: string;
    platform: StoredPublicationSession["platform"];
    expectedOffset: bigint;
    nextOffset: bigint;
    now: Date;
  }): Promise<boolean> {
    if (input.nextOffset < input.expectedOffset)
      throw new Error("PUBLICATION_SESSION_OFFSET_REGRESSION");
    const result = await this.pool.query(
      `UPDATE "PublicationProviderSession" s
          SET "uploadOffset" = $4, "updatedAt" = $5
         FROM "PublicationIntent" i
        WHERE s."publicationIntentId" = $1 AND s."platform" = $2
          AND s."uploadOffset" = $3
          AND i."id" = s."publicationIntentId" AND i."platform" = s."platform"
          AND i."state" IN ('PROCESSING', 'UNKNOWN_REMOTE_STATE')`,
      [
        input.publicationIntentId,
        input.platform,
        input.expectedOffset.toString(),
        input.nextOffset.toString(),
        input.now,
      ],
    );
    return result.rowCount === 1;
  }

  async remove(
    publicationIntentId: string,
    platform: StoredPublicationSession["platform"],
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM "PublicationProviderSession"
        WHERE "publicationIntentId" = $1 AND "platform" = $2`,
      [publicationIntentId, platform],
    );
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
