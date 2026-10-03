// Stdin-only acceptance against the disposable API/media-worker Compose fixture.
// It deliberately rejects normal development or deployment namespaces.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";

assert.equal(process.getuid(), 1000);
assert.equal(process.env.POSTGRES_DB, "cf_api_diagnostic");
assert.equal(process.env.POSTGRES_HOST, "postgres");
assert.equal(process.env.S3_SOURCE_BUCKET, "cf-api-diagnostic");
assert.equal(process.env.S3_ENDPOINT, "http://minio:9000");
assert.equal(process.env.DEPLOYMENT_PROFILE, "other");
assert.equal(process.env.SOURCE_AUTHORIZATION_POLICY, "manual");
assert.equal(process.env.MEDIA_QUEUE_DISABLED, "0");
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
])
  assert.equal(process.env[flag], "0", flag);

const phase = process.env.CF_DIAGNOSTIC_PHASE;
assert.ok(
  [
    "prepare",
    "enqueue",
    "verify",
    "interrupt",
    "verify-interrupt",
    "failure",
  ].includes(phase),
);
const evidencePath = "/tmp/content-factory-api/media-evidence.json";
const base = "http://127.0.0.1:3001/api/v1";
const pool = new Pool({
  host: "postgres",
  port: 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: "cf_api_diagnostic",
  connectionTimeoutMillis: 2000,
});
async function request(path, expected = 200, options = {}) {
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
async function waitFor(path, predicate) {
  const deadline = Date.now() + 90000;
  let value;
  while (Date.now() < deadline) {
    value = await (await request(path)).json();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Diagnostic deadline exceeded: ${JSON.stringify(value)}`);
}
async function upload(bytes) {
  const form = new FormData();
  form.set("name", `Isolated media acceptance ${randomUUID()}`);
  form.set("file", new Blob([bytes], { type: "video/mp4" }), "source.mp4");
  const project = await (
    await request("/projects", 201, {
      method: "POST",
      headers: { "Idempotency-Key": `media-${randomUUID()}` },
      body: form,
    })
  ).json();
  await request(`/projects/${project.id}/source-authorization`, 200, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceVersion: project.source.sourceVersion,
      expectedRevision: project.source.authorization.revision,
      declarationVersion: "source-authorization-v1",
      attested: true,
    }),
  });
  return project;
}
async function cut(projectId, startMs, endMs) {
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `media-cut-${randomUUID()}`,
    },
    body: JSON.stringify({
      segments: [{ clientSegmentId: randomUUID(), startMs, endMs }],
    }),
  };
  const created = await (
    await request(`/projects/${projectId}/cuts`, 201, options)
  ).json();
  const replay = await (
    await request(`/projects/${projectId}/cuts`, 201, options)
  ).json();
  assert.equal(created.requestId, replay.requestId);
  assert.equal(created.jobs.length, 1);
  assert.equal(created.jobs[0].id, replay.jobs[0].id);
  return created.jobs[0];
}
async function verifyResult(jobId, projectId) {
  const job = await waitFor(
    `/pipeline-jobs/${jobId}`,
    (value) => value.state === "READY" || value.state === "FAILED_FINAL",
  );
  assert.equal(job.state, "READY", JSON.stringify(job));
  const bytes = Buffer.from(
    await (await request(`/pipeline-jobs/${jobId}/result`)).arrayBuffer(),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    job.result.sha256,
  );
  assert.equal(bytes.length, Number(job.result.sizeBytes));
  const artifacts = (
    await pool.query(
      'SELECT "status","recipeVersion","ffmpegVersion","lineageSourceVersion" FROM "MediaArtifact" WHERE "pipelineJobId"=$1 AND "projectId"=$2',
      [jobId, projectId],
    )
  ).rows;
  assert.equal(
    artifacts.length,
    1,
    "One logical cut must have exactly one persisted artifact",
  );
  assert.equal(artifacts[0].status, "READY");
  assert.match(artifacts[0].ffmpegVersion, /ffmpeg version/);
  assert.equal(artifacts[0].lineageSourceVersion, 1);
  return {
    jobId,
    sha256: job.result.sha256,
    attempts: job.attempt,
    sizeBytes: job.result.sizeBytes,
  };
}
try {
  if (phase === "prepare") {
    const project = await upload(
      await readFile("/tmp/content-factory-api/fixture.mp4"),
    );
    const probed = await waitFor(
      `/projects/${project.id}`,
      (value) =>
        value.source.durationMs > 0 ||
        value.source.probeState === "FAILED_FINAL",
    );
    assert.ok(probed.source.durationMs >= 12000);
    const job = await cut(project.id, 0, 1000);
    const normal = await verifyResult(job.id, project.id);
    await writeFile(
      evidencePath,
      JSON.stringify({ projectId: project.id, normal }),
      { flag: "wx" },
    );
  } else {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    if (phase === "enqueue" || phase === "interrupt") {
      const job = await cut(
        evidence.projectId,
        phase === "enqueue" ? 1000 : 2000,
        phase === "enqueue" ? 11000 : 12000,
      );
      evidence[phase] = { jobId: job.id };
      await writeFile(evidencePath, JSON.stringify(evidence));
      if (phase === "enqueue") assert.equal(job.state, "QUEUED");
      else
        await waitFor(
          `/pipeline-jobs/${job.id}`,
          (value) => value.state === "PROCESSING",
        );
    } else if (phase === "verify" || phase === "verify-interrupt") {
      const key = phase === "verify" ? "enqueue" : "interrupt";
      evidence[key] = await verifyResult(
        evidence[key].jobId,
        evidence.projectId,
      );
      if (phase === "verify-interrupt")
        assert.ok(
          evidence[key].attempts >= 2,
          "Interrupted attempt must be recovered under a new fenced lease",
        );
      await writeFile(evidencePath, JSON.stringify(evidence));
    } else {
      // Preserve container/sample-table structure but destroy encoded samples.
      // Upload validation should accept the container; the worker must reject
      // undecodable media as a controlled terminal failure.
      const valid = await readFile("/tmp/content-factory-api/fixture.mp4");
      const broken = Buffer.from(valid);
      let corrupted = false;
      for (let offset = 0; offset + 8 <= broken.length;) {
        const size = broken.readUInt32BE(offset);
        assert.ok(size >= 8 && offset + size <= broken.length);
        if (broken.toString("ascii", offset + 4, offset + 8) === "mdat") {
          broken.fill(0, offset + 8, offset + size);
          corrupted = true;
        }
        offset += size;
      }
      assert.equal(corrupted, true);
      const corrupt = await upload(broken);
      const probed = await waitFor(
        `/projects/${corrupt.id}`,
        (value) =>
          value.source.probeState === "FAILED_FINAL" ||
          value.source.durationMs > 0,
      );
      let failure;
      if (probed.source.probeState === "FAILED_FINAL")
        failure = probed.source.probeFailure;
      else {
        const job = await cut(corrupt.id, 0, 1000);
        const failed = await waitFor(
          `/pipeline-jobs/${job.id}`,
          (value) => value.state === "FAILED_FINAL" || value.state === "READY",
        );
        assert.equal(failed.state, "FAILED_FINAL");
        assert.equal(failed.result, undefined);
        failure = failed.failure;
      }
      assert.ok(failure?.code);
      evidence.controlledFailure = {
        projectId: corrupt.id,
        code: failure.code,
      };
      await writeFile(evidencePath, JSON.stringify(evidence));
    }
  }
  console.log(
    JSON.stringify({
      phase,
      passed: true,
      evidence: JSON.parse(await readFile(evidencePath, "utf8")),
    }),
  );
} finally {
  await pool.end();
}
