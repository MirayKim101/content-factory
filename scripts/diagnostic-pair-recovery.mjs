// Deliberately small, non-versioned, disposable-fixture recovery drill. This is
// not a backup service and must never select a development/production namespace.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const maxObjectBytes = 1024 * 1024;
const maxPairBytes = 16 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function validateManifest(manifest) {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.diagnosticOnly, true);
  assert.equal(manifest.promotionApproved, false);
  assert.equal(manifest.sourceProject, "cf-api-proof-20261003");
  assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(manifest.databaseSha256, digestPattern);
  assert.match(manifest.databaseState.sha256, digestPattern);
  assert.equal(manifest.databaseState.migrations, 45);
  assert.equal(manifest.databaseState.unvalidatedConstraints, 0);
  assert.ok(
    Array.isArray(manifest.objects) &&
      manifest.objects.length > 0 &&
      manifest.objects.length <= 100,
  );
  const keys = new Map();
  let total = 0;
  for (const object of manifest.objects) {
    assert.match(object.key, /^(?:sources|editorial)\/[A-Za-z0-9._/-]+$/);
    assert.ok(
      object.key
        .split("/")
        .every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            !/^(seanova(?:-new)?|dockerserver)$/i.test(part),
        ),
    );
    assert.equal(keys.has(object.key), false, "Duplicate snapshot object");
    assert.match(object.sha256, digestPattern);
    assert.equal(object.filename, `${sha256(object.key)}.bin`);
    assert.ok(
      Number.isSafeInteger(object.sizeBytes) &&
        object.sizeBytes > 0 &&
        object.sizeBytes <= maxObjectBytes,
    );
    assert.equal(object.metadata?.sha256, object.sha256);
    assert.equal(object.contentType, "video/mp4");
    assert.ok(typeof object.etag === "string" && object.etag.length > 0);
    assert.equal(
      object.storageVersion,
      undefined,
      "Versioned recovery needs a separately designed metadata remap",
    );
    keys.set(object.key, object);
    total += object.sizeBytes;
  }
  assert.ok(total <= maxPairBytes);
  assert.ok(
    Array.isArray(manifest.readyArtifacts) &&
      manifest.readyArtifacts.length > 0,
  );
  for (const artifact of manifest.readyArtifacts) {
    const object = keys.get(artifact.objectKey);
    assert.ok(
      object,
      "Database references an object absent from its paired snapshot",
    );
    assert.equal(object.sha256, artifact.sha256);
    assert.equal(String(object.sizeBytes), artifact.sizeBytes);
    assert.equal(object.contentType, artifact.contentType);
    assert.equal(artifact.storageVersion, null);
  }
  return manifest;
}

export async function hashFile(path) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= maxPairBytes,
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyFiles(folder, manifest) {
  validateManifest(manifest);
  const directory = await lstat(folder);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  const objectDirectory = await lstat(resolve(folder, "objects"));
  assert.ok(objectDirectory.isDirectory() && !objectDirectory.isSymbolicLink());
  const dump = resolve(folder, "database.dump");
  const dumpInfo = await lstat(dump);
  assert.ok(
    dumpInfo.isFile() &&
      !dumpInfo.isSymbolicLink() &&
      dumpInfo.size > 0 &&
      dumpInfo.size <= maxPairBytes,
  );
  assert.equal(
    await hashFile(dump),
    manifest.databaseSha256,
    "Database dump does not belong to this recovery pair",
  );
  for (const object of manifest.objects) {
    const path = resolve(folder, "objects", object.filename);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.size, object.sizeBytes);
    assert.equal(
      await hashFile(path),
      object.sha256,
      "Snapshot object checksum mismatch",
    );
  }
}

async function main() {
  assert.equal(process.getuid(), 1000);
  assert.equal(process.env.POSTGRES_DB, "cf_api_diagnostic");
  assert.equal(process.env.POSTGRES_HOST, "postgres");
  assert.equal(process.env.POSTGRES_USER, "cf_diagnostic");
  assert.equal(process.env.POSTGRES_PASSWORD, "cf_diagnostic_fixture_only");
  assert.equal(process.env.S3_SOURCE_BUCKET, "cf-api-diagnostic");
  assert.equal(process.env.S3_ENDPOINT, "http://minio:9000");
  assert.equal(process.env.S3_ACCESS_KEY, "cf_diagnostic_api");
  assert.equal(process.env.S3_SECRET_KEY, "cf_diagnostic_api_fixture_only");
  assert.equal(process.env.DEPLOYMENT_PROFILE, "other");
  assert.equal(process.env.SOURCE_AUTHORIZATION_POLICY, "manual");
  for (const flag of [
    "PUBLISHING_ENABLED",
    "YOUTUBE_PUBLISHING_ENABLED",
    "TIKTOK_PUBLISHING_ENABLED",
    "TWITCH_INGESTION_ENABLED",
    "TWITCH_VOD_AUTO_INGEST_ENABLED",
    "TWITCH_VOD_MEDIA_GATEWAY_ENABLED",
    "VERTICAL_RENDER_ENABLED",
    "CLIP_GENERATION_ENABLED",
    "AI_CONTEXT_ENABLED",
    "EDITORIAL_FRAMES_ENABLED",
    "RESEARCH_TEXT_ENABLED",
    "THUMBNAIL_SUGGESTIONS_ENABLED",
  ])
    assert.equal(process.env[flag], "0", flag);
  const phase = process.env.CF_DIAGNOSTIC_PAIR_PHASE;
  assert.ok(["backup", "restore", "verify"].includes(phase));
  const expectedProject =
    phase === "backup" ? "cf-api-proof-20261003" : "cf-pair-restore-20261003";
  assert.equal(process.env.CF_DIAGNOSTIC_PROJECT, expectedProject);
  assert.match(process.env.CF_DIAGNOSTIC_SOURCE_REVISION, /^[a-f0-9]{40}$/);
  const folder = "/recovery";
  const info = await lstat(folder);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  const require = createRequire(`${process.cwd()}/package.json`);
  const { Pool } = require("pg");
  const {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
  } = require("@aws-sdk/client-s3");
  const pool = new Pool({
    host: "postgres",
    port: 5432,
    user: "cf_diagnostic",
    password: process.env.POSTGRES_PASSWORD,
    database: "cf_api_diagnostic",
    connectionTimeoutMillis: 2000,
    statement_timeout: 10000,
  });
  const s3 = new S3Client({
    endpoint: "http://minio:9000",
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: "cf_diagnostic_api",
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });
  const send = (command) =>
    s3.send(command, { abortSignal: AbortSignal.timeout(10000) });
  const bucket = "cf-api-diagnostic";
  const manifestPath = resolve(folder, "manifest.json");
  async function state() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const active = (
        await client.query(
          `SELECT COUNT(*)::int AS n FROM "PipelineJob" WHERE "state" IN ('QUEUED','PROCESSING','RETRY_WAIT')`,
        )
      ).rows[0].n;
      assert.equal(
        active,
        0,
        "Diagnostic writers must drain before paired backup",
      );
      const names = (
        await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        )
      ).rows.map((row) => row.tablename);
      assert.equal(names.length, 74);
      const hash = createHash("sha256");
      const counts = {};
      for (const name of names) {
        assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
        const rows = (
          await client.query(
            `SELECT to_jsonb(t)::text AS data FROM "${name}" t ORDER BY to_jsonb(t)::text LIMIT 10001`,
          )
        ).rows;
        assert.ok(rows.length <= 10000);
        counts[name] = rows.length;
        hash.update(`${name}\0`);
        for (const row of rows) hash.update(`${row.data}\n`);
      }
      const migrations = (
        await client.query(
          'SELECT COUNT(*)::int AS n FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL',
        )
      ).rows[0].n;
      const unvalidatedConstraints = (
        await client.query(
          "SELECT COUNT(*)::int AS n FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated",
        )
      ).rows[0].n;
      const artifacts = (
        await client.query(
          'SELECT "id","objectKey","sizeBytes"::text,"sha256","contentType","storageVersion" FROM "MediaArtifact" WHERE "status"=\'READY\' ORDER BY "id"',
        )
      ).rows;
      await client.query("COMMIT");
      return {
        databaseState: {
          sha256: hash.digest("hex"),
          counts,
          migrations,
          unvalidatedConstraints,
        },
        artifacts,
      };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }
  async function inventory() {
    const result = await send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 101 }),
    );
    assert.equal(result.IsTruncated, false);
    const objects = result.Contents ?? [];
    assert.ok(objects.length <= 100);
    return objects.sort((a, b) => a.Key.localeCompare(b.Key));
  }
  async function readObject(key) {
    const result = await send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    assert.equal(result.VersionId, undefined);
    assert.ok(
      result.Body &&
        result.ContentLength > 0 &&
        result.ContentLength <= maxObjectBytes,
    );
    const chunks = [];
    let length = 0;
    const timer = setTimeout(
      () => result.Body.destroy(new Error("Diagnostic object read timed out")),
      10000,
    );
    try {
      for await (const chunk of result.Body) {
        length += chunk.length;
        assert.ok(length <= maxObjectBytes);
        chunks.push(chunk);
      }
      assert.equal(length, result.ContentLength);
      return { bytes: Buffer.concat(chunks), result };
    } finally {
      clearTimeout(timer);
      result.Body.destroy();
    }
  }
  try {
    const baseline = await state();
    if (phase === "backup") {
      const objects = [];
      await mkdir(resolve(folder, "objects"), {
        recursive: false,
        mode: 0o700,
      });
      for (const entry of await inventory()) {
        const { bytes, result } = await readObject(entry.Key);
        const filename = `${sha256(entry.Key)}.bin`;
        await writeFile(resolve(folder, "objects", filename), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        objects.push({
          key: entry.Key,
          filename,
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
          metadata: result.Metadata,
          contentType: result.ContentType,
          etag: result.ETag,
        });
      }
      const manifest = {
        version: 1,
        diagnosticOnly: true,
        promotionApproved: false,
        sourceProject: expectedProject,
        sourceRevision: process.env.CF_DIAGNOSTIC_SOURCE_REVISION,
        databaseSha256: await hashFile(resolve(folder, "database.dump")),
        ...baseline,
        readyArtifacts: baseline.artifacts,
        objects,
        capturedAt: new Date().toISOString(),
      };
      delete manifest.artifacts;
      await verifyFiles(folder, manifest);
      assert.deepEqual(
        await state(),
        baseline,
        "Database changed while snapshotting objects",
      );
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          phase,
          passed: true,
          objects: objects.length,
          readyArtifacts: baseline.artifacts.length,
          databaseSha256: manifest.databaseSha256,
          databaseStateSha256: baseline.databaseState.sha256,
        }),
      );
    } else {
      const manifestInfo = await lstat(manifestPath);
      assert.ok(
        manifestInfo.isFile() &&
          !manifestInfo.isSymbolicLink() &&
          manifestInfo.size <= 1024 * 1024,
      );
      const manifest = validateManifest(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      assert.equal(
        manifest.sourceRevision,
        process.env.CF_DIAGNOSTIC_SOURCE_REVISION,
      );
      await verifyFiles(folder, manifest);
      assert.deepEqual(
        baseline.databaseState,
        manifest.databaseState,
        "Restored metadata differs from the matching object snapshot",
      );
      assert.deepEqual(baseline.artifacts, manifest.readyArtifacts);
      if (phase === "restore") {
        const outputInfo = await lstat("/evidence");
        assert.ok(outputInfo.isDirectory() && !outputInfo.isSymbolicLink());
        assert.equal(
          (await inventory()).length,
          0,
          "Restore never overwrites an existing object namespace",
        );
        for (const object of manifest.objects) {
          const bytes = await readFile(
            resolve(folder, "objects", object.filename),
          );
          assert.equal(sha256(bytes), object.sha256);
          await send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: object.key,
              Body: bytes,
              ContentType: object.contentType,
              Metadata: object.metadata,
            }),
          );
        }
      }
      const actual = await inventory();
      assert.deepEqual(
        actual.map((object) => object.Key),
        manifest.objects.map((object) => object.key),
      );
      for (const object of manifest.objects) {
        const { bytes, result } = await readObject(object.key);
        assert.equal(sha256(bytes), object.sha256);
        assert.equal(bytes.length, object.sizeBytes);
        assert.equal(result.ETag, object.etag);
        assert.equal(result.ContentType, object.contentType);
        assert.deepEqual(result.Metadata, object.metadata);
      }
      assert.deepEqual(await state(), baseline);
      const evidence = {
        phase,
        emptyTargetBeforeRestore: phase === "restore" ? true : undefined,
        passed: true,
        diagnosticOnly: true,
        promotionApproved: false,
        databaseStateSha256: baseline.databaseState.sha256,
        databaseSha256: manifest.databaseSha256,
        objects: actual.length,
        readyArtifacts: baseline.artifacts.length,
        verifiedAt: new Date().toISOString(),
      };
      if (phase === "restore")
        await writeFile(
          "/evidence/restore-evidence.json",
          `${JSON.stringify(evidence, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
      console.log(JSON.stringify(evidence));
    }
  } finally {
    await pool.end();
    s3.destroy();
  }
}

if (process.argv.includes("--run-diagnostic-pair")) await main();
