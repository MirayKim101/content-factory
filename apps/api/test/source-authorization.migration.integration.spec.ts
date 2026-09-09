import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/config/environment.js";

const migrationDirectory = resolve(import.meta.dirname, "../prisma/migrations");
const baseMigrations = [
  "20260901121007_stage1_source_upload/migration.sql",
  "20260901124900_harden_source_upload/migration.sql",
];
const authorizationMigration =
  "20260909120000_exact_source_authorization/migration.sql";

describe("exact source authorization migration", () => {
  let admin: Pool;
  const databases: string[] = [];

  beforeAll(() => {
    const url = new URL(databaseUrl());
    url.pathname = "/postgres";
    url.search = "";
    admin = new Pool({ connectionString: url.toString(), max: 1 });
  });

  afterEach(async () => {
    for (const database of databases.splice(0)) {
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    }
  });

  afterAll(async () => admin.end());

  it("backfills every legacy source with unchanged audit data", async () => {
    const pool = await isolatedDatabase(admin, databases);
    try {
      await applyBase(pool);
      await pool.query(validLegacyFixture);
      await pool.query(await migrationSql(authorizationMigration));

      const result = await pool.query<{
        sources: string;
        authorizations: string;
        legacy_cleared: string;
        audit_preserved: string;
      }>(`
        SELECT
          (SELECT count(*) FROM "VideoSource") AS sources,
          (SELECT count(*) FROM "SourceAuthorization") AS authorizations,
          count(*) FILTER (
            WHERE auth."status" = 'CLEARED'
              AND auth."basis" = 'LEGACY_ATTESTATION'
          ) AS legacy_cleared,
          count(*) FILTER (
            WHERE auth."confirmedAt" = project."rightsConfirmedAt"
              AND auth."declarationVersion" = project."rightsDeclarationVersion"
          ) AS audit_preserved
        FROM "SourceAuthorization" auth
        JOIN "VideoSource" source ON source."id" = auth."sourceId"
        JOIN "Project" project ON project."id" = source."projectId"
      `);
      expect(result.rows[0]).toEqual({
        sources: "3",
        authorizations: "3",
        legacy_cleared: "3",
        audit_preserved: "3",
      });
    } finally {
      await pool.end();
    }
  });

  it("rolls back the whole migration when legacy source data is malformed", async () => {
    const pool = await isolatedDatabase(admin, databases);
    try {
      await applyBase(pool);
      await pool.query(invalidLegacyFixture);
      await expect(
        pool.query(await migrationSql(authorizationMigration)),
      ).rejects.toThrow(/SOURCE_AUTHORIZATION_LEGACY_DATA_INVALID/);

      const state = await pool.query<{
        table_missing: boolean;
        is_nullable: string;
      }>(`
        SELECT
          to_regclass('public."SourceAuthorization"') IS NULL AS table_missing,
          is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Project'
          AND column_name = 'rightsConfirmedAt'
      `);
      expect(state.rows[0]).toEqual({ table_missing: true, is_nullable: "NO" });
    } finally {
      await pool.end();
    }
  });
});

async function isolatedDatabase(
  admin: Pool,
  databases: string[],
): Promise<Pool> {
  const database = `cf_auth_migration_${randomUUID().replaceAll("-", "")}`;
  databases.push(database);
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(databaseUrl());
  url.pathname = `/${database}`;
  url.search = "";
  return new Pool({ connectionString: url.toString(), max: 1 });
}

async function applyBase(pool: Pool): Promise<void> {
  for (const migration of baseMigrations) {
    await pool.query(await migrationSql(migration));
  }
}

function migrationSql(relativePath: string): Promise<string> {
  return readFile(resolve(migrationDirectory, relativePath), "utf8");
}

const validLegacyFixture = `
  INSERT INTO "Project" ("id", "idempotencyKey", "requestFingerprint", "name", "rightsConfirmedAt", "rightsDeclarationVersion", "createdAt", "updatedAt") VALUES
    ('00000000-0000-4000-8000-000000000001', 'legacy-0001', repeat('a', 64), 'Legacy 1', '2026-09-01T01:00:00Z', 'upload-rights-v1', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z'),
    ('00000000-0000-4000-8000-000000000002', 'legacy-0002', repeat('b', 64), 'Legacy 2', '2026-09-02T01:00:00Z', 'upload-rights-v1', '2026-09-02T00:00:00Z', '2026-09-02T01:00:00Z'),
    ('00000000-0000-4000-8000-000000000003', 'legacy-0003', repeat('c', 64), 'Legacy 3', '2026-09-03T01:00:00Z', 'upload-rights-v1', '2026-09-03T00:00:00Z', '2026-09-03T01:00:00Z');
  INSERT INTO "VideoSource" ("id", "projectId", "status", "sourceVersion", "originalFilename", "contentType", "sizeBytes", "sha256", "createdAt", "updatedAt") VALUES
    ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'READY', 1, '1.mp4', 'video/mp4', 1, repeat('a', 64), now(), now()),
    ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'READY', 2, '2.mp4', 'video/mp4', 2, repeat('b', 64), now(), now()),
    ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', 'READY', 3, '3.mp4', 'video/mp4', 3, repeat('c', 64), now(), now());
`;

const invalidLegacyFixture = `
  INSERT INTO "Project" ("id", "idempotencyKey", "requestFingerprint", "name", "rightsConfirmedAt", "rightsDeclarationVersion", "createdAt", "updatedAt") VALUES
    ('00000000-0000-4000-8000-000000000009', 'invalid-0001', repeat('d', 64), 'Invalid', now(), 'upload-rights-v1', now(), now());
  INSERT INTO "VideoSource" ("id", "projectId", "status", "sourceVersion", "originalFilename", "contentType", "sizeBytes", "sha256", "createdAt", "updatedAt") VALUES
    ('10000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000009', 'READY', 1, 'bad.mp4', 'video/mp4', 1, 'bad', now(), now());
`;
