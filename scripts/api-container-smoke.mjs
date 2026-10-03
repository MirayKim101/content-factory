// Run via stdin inside the isolated diagnostic API container. Never use this
// write-capable fixture against an existing database or object namespace.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { Queue, Worker } from "bullmq";
import { Pool } from "pg";

const require = createRequire(`${process.cwd()}/package.json`);
const requireForBullmq = createRequire(require.resolve("bullmq"));
const msgpackr = await import(
  pathToFileURL(requireForBullmq.resolve("msgpackr")).href
);
assert.equal(msgpackr.isNativeAccelerationEnabled, false);

assert.equal(process.env.POSTGRES_DB, "cf_api_diagnostic");
assert.equal(process.env.POSTGRES_HOST, "postgres");
assert.equal(process.env.S3_SOURCE_BUCKET, "cf-api-diagnostic");
assert.equal(process.env.S3_ENDPOINT, "http://minio:9000");
assert.equal(process.env.DEPLOYMENT_PROFILE, "other");
assert.equal(process.env.SOURCE_AUTHORIZATION_POLICY, "manual");
assert.equal(process.env.MEDIA_QUEUE_DISABLED, "1");
assert.equal(process.getuid(), 1000);
for (const flag of [
  "PUBLISHING_ENABLED",
  "YOUTUBE_PUBLISHING_ENABLED",
  "TIKTOK_PUBLISHING_ENABLED",
  "TWITCH_INGESTION_ENABLED",
  "TWITCH_VOD_AUTO_INGEST_ENABLED",
  "TWITCH_VOD_MEDIA_GATEWAY_ENABLED",
  "EDITORIAL_FRAMES_ENABLED",
  "VERTICAL_RENDER_ENABLED",
  "CLIP_GENERATION_ENABLED",
  "AI_CONTEXT_ENABLED",
  "RESEARCH_TEXT_ENABLED",
  "THUMBNAIL_SUGGESTIONS_ENABLED",
]) {
  assert.equal(process.env[flag], "0", flag);
}
const base = "http://127.0.0.1:3001/api/v1";
async function request(path, expected, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    response.status,
    expected,
    `${path}: ${await response.clone().text()}`,
  );
  return response;
}
assert.deepEqual(await (await request("/health", 200)).json(), {
  status: "ok",
});
const ready = await request("/readiness", 200);
assert.equal(ready.headers.get("cache-control"), "no-store");
assert.deepEqual(await ready.json(), { status: "ready" });

const bytes = await readFile("/tmp/content-factory-api/fixture.mp4");
assert.ok(bytes.length > 0 && bytes.length < 1048576);
const baselinePool = new Pool({
  host: "postgres",
  port: 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: "cf_api_diagnostic",
  connectionTimeoutMillis: 2000,
});
let baselineCount;
try {
  baselineCount = (
    await baselinePool.query('SELECT COUNT(*)::int AS count FROM "Project"')
  ).rows[0].count;
} finally {
  await baselinePool.end();
}
const key = `diagnostic-${randomUUID()}`;
function upload(content = bytes, name = "Diagnostic source") {
  const body = new FormData();
  body.set("name", name);
  body.set("file", new Blob([content], { type: "video/mp4" }), "source.mp4");
  return { method: "POST", headers: { "Idempotency-Key": key }, body };
}
const created = await (await request("/projects", 201, upload())).json();
assert.equal(created.status, "SOURCE_READY");
assert.equal(created.source.authorization.status, "NOT_REVIEWED");
assert.equal(created.source.authorization.usable, false);
assert.equal(
  created.source.sha256,
  createHash("sha256").update(bytes).digest("hex"),
);
const replay = await (await request("/projects", 201, upload())).json();
assert.equal(replay.id, created.id);
await request("/projects", 409, upload(bytes, "Conflicting source"));
const denied = await (
  await request(`/projects/${created.id}/source`, 403)
).json();
assert.equal(denied.error.code, "SOURCE_AUTHORIZATION_REQUIRED");
const authorized = await (
  await request(`/projects/${created.id}/source-authorization`, 200, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceVersion: created.source.sourceVersion,
      expectedRevision: created.source.authorization.revision,
      declarationVersion: "source-authorization-v1",
      attested: true,
    }),
  })
).json();
assert.equal(authorized.source.authorization.basis, "OPERATOR_ATTESTATION");
assert.equal(authorized.source.authorization.usable, true);
const downloaded = Buffer.from(
  await (await request(`/projects/${created.id}/source`, 200)).arrayBuffer(),
);
assert.deepEqual(downloaded, bytes);
const ranged = await request(`/projects/${created.id}/source`, 206, {
  headers: { Range: "bytes=0-15" },
});
assert.equal(ranged.headers.get("content-range"), `bytes 0-15/${bytes.length}`);
assert.deepEqual(
  Buffer.from(await ranged.arrayBuffer()),
  bytes.subarray(0, 16),
);
await request(`/projects/${created.id}/source`, 416, {
  headers: { Range: `bytes=${bytes.length}-` },
});
await request("/projects", 415, upload(Buffer.from("not an MP4")));
await request("/projects", 413, upload(Buffer.alloc(1048577)));
assert.deepEqual(
  (await readdir("/tmp/content-factory-api")).filter((name) =>
    name.startsWith("request-"),
  ),
  [],
);

const pool = new Pool({
  host: "postgres",
  port: 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: "cf_api_diagnostic",
  connectionTimeoutMillis: 2000,
});
try {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM "Project"',
  );
  assert.equal(
    result.rows[0].count,
    baselineCount + 1,
    "Replay must not create a second project",
  );
} finally {
  await pool.end();
}

// Exercise BullMQ serialization and the mandatory ioredis closure with a
// separately named tiny queue; no media or publication job is admitted.
const connection = {
  host: "redis",
  port: 6379,
  password: process.env.REDIS_PASSWORD,
};
const queueName = `diagnostic-${randomUUID()}`;
const queue = new Queue(queueName, { connection });
const worker = new Worker(
  queueName,
  async (job) => ({ echoed: job.data.message }),
  { connection },
);
const errors = [];
worker.on("error", (error) => errors.push(error));
try {
  const job = await queue.add(
    "round-trip",
    { message: "pure-JS fallback" },
    { jobId: "one-logical-job" },
  );
  const replayJob = await queue.add(
    "round-trip",
    { message: "pure-JS fallback" },
    { jobId: "one-logical-job" },
  );
  assert.equal(replayJob.id, job.id);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && (await job.getState()) !== "completed") {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const completed = await queue.getJob(job.id);
  assert.deepEqual(completed.returnvalue, { echoed: "pure-JS fallback" });
  assert.equal(await queue.getCompletedCount(), 1);
  assert.deepEqual(errors, []);
  await completed.remove();
} finally {
  await worker.close();
  await queue.close();
}
console.log(
  JSON.stringify({
    result: "API_CONTAINER_SMOKE_OK",
    projectId: created.id,
    sourceBytes: bytes.length,
    checks: [
      "non-root",
      "manual-authorization",
      "disabled-provider-gates",
      "readiness",
      "upload",
      "idempotency",
      "checksum",
      "download",
      "range-206-416",
      "failure-413-415",
      "scratch-cleanup",
      "PostgreSQL",
      "BullMQ-ioredis-duplicate-safe-roundtrip",
    ],
  }),
);
