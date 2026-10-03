import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { exportContext } from "./export-api-build-context.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const exactSha = /^[a-f0-9]{40}$/;
const projectName = /^cf-media-ci-[a-f0-9]{12}-[1-9][0-9]*$/;
const protectedPath = /(?:^|\/)(?:seanova(?:-new)?|dockerserver)(?:\/|$)/i;
const knownLocalMinioId =
  "sha256:eea60ca39c6c3b36cff6bbd624211ba1db49a8bc0d438d3d6ddc65bcef8b563f";
export const minioBuildPins = Object.freeze({
  goImage:
    "golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848",
  runtimeImage:
    "debian:12.12-slim@sha256:d5d3f9c23164ea16f31852f95bd5959aad1c5e854332fe00f7b3a20fcc9f635c",
  minioRevision: "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a",
  mcRevision: "7394ce0dd2a80935aded936b09fa12cbb3cb8096",
});
const fixturePaths = new Set([
  "apps/api/test/media-pipeline.api.integration.spec.ts",
  "apps/api/vitest.integration.config.ts",
  "infrastructure/minio/Dockerfile",
  "infrastructure/minio/healthcheck",
  "infrastructure/minio/provision",
]);
const disabledExternalFlags = [
  "ASSEMBLY_RENDER_ENABLED",
  "EDITORIAL_APPROVAL_ENABLED",
  "EDITORIAL_INTEGRATED_REVIEW_ENABLED",
  "EDITORIAL_EXPORT_ENABLED",
  "AI_CONTEXT_ENABLED",
  "EDITORIAL_FRAMES_ENABLED",
  "RESEARCH_TEXT_ENABLED",
  "THUMBNAIL_SUGGESTIONS_ENABLED",
  "PUBLISHING_ENABLED",
  "YOUTUBE_PUBLISHING_ENABLED",
  "TIKTOK_PUBLISHING_ENABLED",
  "TWITCH_INGESTION_ENABLED",
  "TWITCH_VOD_AUTO_INGEST_ENABLED",
  "TWITCH_VOD_MEDIA_GATEWAY_ENABLED",
  "VERTICAL_RENDER_ENABLED",
  "CLIP_GENERATION_ENABLED",
];

export function validateRevision(revision) {
  assert.match(
    revision,
    exactSha,
    "Supply an exact lowercase 40-character SHA",
  );
  return revision;
}

export function ownedProject(revision, pid = process.pid) {
  validateRevision(revision);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  return `cf-media-ci-${revision.slice(0, 12)}-${pid}`;
}

export function assertOwnedProject(project) {
  assert.match(project, projectName, "Refusing to manage a non-CI project");
  return project;
}

export function assertFixturePath(path) {
  assert.equal(
    fixturePaths.has(path),
    true,
    `Unexpected fixture path: ${path}`,
  );
  assert.equal(
    protectedPath.test(path),
    false,
    `Forbidden fixture path: ${path}`,
  );
  assert.equal(path.includes(".."), false, `Unsafe fixture path: ${path}`);
  return path;
}

export function diagnosticEnvironment() {
  return Object.fromEntries(disabledExternalFlags.map((flag) => [flag, "0"]));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
    ...options,
  });
}

function git(args, options) {
  return run("git", ["-C", root, ...args], options);
}

function docker(args, options) {
  return run("docker", args, options);
}

function compose(project, file, args, options) {
  assertOwnedProject(project);
  return docker(
    ["compose", "--project-name", project, "--file", file, ...args],
    options,
  );
}

async function writeCommittedFile(revision, path, destination) {
  assertFixturePath(path);
  const entry = git(["ls-tree", revision, "--", path], {
    stdio: "pipe",
  }).trim();
  assert.match(entry, /^(100644|100755) blob [a-f0-9]{40}\t/);
  const content = git(["cat-file", "blob", `${revision}:${path}`], {
    stdio: "pipe",
  });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { flag: "wx", mode: 0o644 });
}

async function materializeFixture(revision) {
  const temporaryRoot = resolve(root, "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  assert.equal((await lstat(temporaryRoot)).isSymbolicLink(), false);
  const folder = await mkdtemp(resolve(temporaryRoot, "ci-media-api-gate-"));
  for (const path of fixturePaths) {
    await writeCommittedFile(revision, path, resolve(folder, path));
  }
  return folder;
}

export function composeFixture({
  project,
  apiBuildImage,
  migrateImage,
  minioImage,
  folder,
}) {
  assertOwnedProject(project);
  for (const image of [apiBuildImage, migrateImage, minioImage]) {
    assert.match(image, /^[a-z0-9][a-z0-9:._-]*$/);
  }
  const apiTestPath = resolve(
    folder,
    "apps/api/test/media-pipeline.api.integration.spec.ts",
  );
  const vitestConfigPath = resolve(
    folder,
    "apps/api/vitest.integration.config.ts",
  );
  const provisionPath = resolve(folder, "infrastructure/minio/provision");
  const testEnvironment = {
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    PORT: "3001",
    DEPLOYMENT_PROFILE: "other",
    SOURCE_AUTHORIZATION_POLICY: "manual",
    POSTGRES_DB: "cf_media_ci",
    POSTGRES_USER: "cf_media_ci",
    POSTGRES_PASSWORD: "cf_media_ci_fixture_only",
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: "5432",
    REDIS_HOST: "redis",
    REDIS_PORT: "6379",
    REDIS_PASSWORD: "cf_media_ci_fixture_only",
    S3_ENDPOINT: "http://minio:9000",
    S3_REGION: "us-east-1",
    S3_SOURCE_BUCKET: "cf-media-ci",
    S3_ACCESS_KEY: "cf_media_ci",
    S3_SECRET_KEY: "cf_media_ci_fixture_only",
    MEDIA_QUEUE_DISABLED: "0",
    ...diagnosticEnvironment(),
  };
  const compose = {
    name: project,
    services: {
      postgres: {
        image:
          "postgres:18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280",
        environment: {
          POSTGRES_DB: testEnvironment.POSTGRES_DB,
          POSTGRES_USER: testEnvironment.POSTGRES_USER,
          POSTGRES_PASSWORD: testEnvironment.POSTGRES_PASSWORD,
        },
        networks: ["proof"],
        healthcheck: {
          test: [
            "CMD",
            "pg_isready",
            "--username=cf_media_ci",
            "--dbname=cf_media_ci",
          ],
          interval: "2s",
          timeout: "2s",
          retries: 30,
        },
      },
      redis: {
        image:
          "redis:8.10.1@sha256:298e5b3bc566bade82f46ad5511777a4a07a294097ce16ada2f6a42be5239df5",
        command: [
          "redis-server",
          "--requirepass",
          testEnvironment.REDIS_PASSWORD,
        ],
        networks: ["proof"],
        healthcheck: {
          test: [
            "CMD",
            "redis-cli",
            "--no-auth-warning",
            "--pass",
            testEnvironment.REDIS_PASSWORD,
            "ping",
          ],
          interval: "2s",
          timeout: "2s",
          retries: 30,
        },
      },
      minio: {
        image: minioImage,
        environment: {
          MINIO_ROOT_USER: "cf_media_ci_root",
          MINIO_ROOT_PASSWORD: "cf_media_ci_root_fixture_only",
        },
        command: ["server", "/data", "--console-address", ":9001"],
        networks: ["proof"],
        healthcheck: {
          test: ["CMD", "/usr/local/bin/healthcheck"],
          interval: "2s",
          timeout: "2s",
          retries: 30,
        },
      },
      "minio-init": {
        image: minioImage,
        entrypoint: ["/bin/sh", "/provision"],
        environment: {
          MINIO_ROOT_USER: "cf_media_ci_root",
          MINIO_ROOT_PASSWORD: "cf_media_ci_root_fixture_only",
          S3_SOURCE_BUCKET: testEnvironment.S3_SOURCE_BUCKET,
          S3_ACCESS_KEY: testEnvironment.S3_ACCESS_KEY,
          S3_SECRET_KEY: testEnvironment.S3_SECRET_KEY,
        },
        volumes: [`${provisionPath}:/provision:ro`],
        networks: ["proof"],
      },
      "api-migrate": {
        image: migrateImage,
        user: "1000:1000",
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        tmpfs: ["/tmp:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700"],
        environment: {
          DATABASE_URL:
            "postgresql://cf_media_ci:cf_media_ci_fixture_only@postgres:5432/cf_media_ci?schema=public",
        },
        networks: ["proof"],
      },
      "api-test": {
        image: apiBuildImage,
        user: "1000:1000",
        working_dir: "/workspace/apps/api",
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        pids_limit: 128,
        mem_limit: "768m",
        cpus: 1,
        tmpfs: [
          "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700",
          "/workspace/apps/api/node_modules/.vite:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700",
          "/workspace/apps/api/node_modules/.vite-temp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700",
        ],
        volumes: [
          `${apiTestPath}:/workspace/apps/api/test/media-pipeline.api.integration.spec.ts:ro`,
          `${vitestConfigPath}:/workspace/apps/api/vitest.integration.config.ts:ro`,
        ],
        environment: testEnvironment,
        command: [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "test/media-pipeline.api.integration.spec.ts",
          "--testTimeout=20000",
        ],
        networks: ["proof"],
      },
    },
    networks: { proof: { internal: true } },
  };
  return `${JSON.stringify(compose, null, 2)}\n`;
}

function ownedContainerIds(project) {
  assertOwnedProject(project);
  const output = docker(
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    { stdio: "pipe" },
  );
  return output.split("\n").filter(Boolean);
}

function assertOwnedContainers(project) {
  for (const id of ownedContainerIds(project)) {
    const label = docker(
      [
        "inspect",
        "--format",
        '{{ index .Config.Labels "com.docker.compose.project" }}',
        id,
      ],
      { stdio: "pipe" },
    ).trim();
    assert.equal(label, project, `Refusing to clean foreign container ${id}`);
  }
}

function assertOwnedVolumes(project) {
  const output = docker(
    [
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    { stdio: "pipe" },
  );
  for (const volume of output.split("\n").filter(Boolean)) {
    const label = docker(
      [
        "volume",
        "inspect",
        "--format",
        '{{ index .Labels "com.docker.compose.project" }}',
        volume,
      ],
      { stdio: "pipe" },
    ).trim();
    assert.equal(label, project, `Refusing to clean foreign volume ${volume}`);
  }
}

function cleanup(project, composeFile) {
  assertOwnedProject(project);
  assertOwnedContainers(project);
  assertOwnedVolumes(project);
  compose(project, composeFile, ["down", "--volumes", "--remove-orphans"]);
  assert.deepEqual(ownedContainerIds(project), []);
  return { project, containersRemaining: 0, volumesChecked: true };
}

function migrationCount(project, composeFile) {
  const sql =
    'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL';
  const output = compose(
    project,
    composeFile,
    [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-ceu",
      `PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc '${sql}'`,
    ],
    { stdio: "pipe" },
  ).trim();
  assert.equal(output, "45", "Fresh database must contain all 45 migrations");
  return Number(output);
}

function minioImage(fixtureFolder, tag) {
  const existing = process.env.CF_MEDIA_CI_MINIO_IMAGE;
  if (existing) {
    const id = docker(["image", "inspect", "--format", "{{.Id}}", existing], {
      stdio: "pipe",
    }).trim();
    assert.equal(id, knownLocalMinioId, "Local MinIO image ID is not approved");
    return existing;
  }
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Local runs must supply CF_MEDIA_CI_MINIO_IMAGE; CI builds the committed MinIO fixture",
  );
  docker([
    "build",
    "--tag",
    tag,
    "--build-arg",
    `GO_IMAGE=${minioBuildPins.goImage}`,
    "--build-arg",
    `RUNTIME_IMAGE=${minioBuildPins.runtimeImage}`,
    "--build-arg",
    "MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z",
    "--build-arg",
    "MC_VERSION=RELEASE.2025-08-13T08-35-41Z",
    resolve(fixtureFolder, "infrastructure/minio"),
  ]);
  return tag;
}

export async function runGate(revision) {
  validateRevision(revision);
  assert.equal(
    git(["rev-parse", `${revision}^{commit}`], { stdio: "pipe" }).trim(),
    revision,
  );
  const project = ownedProject(revision);
  const suffix = `${revision.slice(0, 12)}-${process.pid}`;
  let fixtureFolder;
  let composeFile;
  let cleanupEvidence;
  try {
    fixtureFolder = await materializeFixture(revision);
    const apiContext = await exportContext(revision);
    const apiBuildImage = `cf-media-ci-api-build:${suffix}`;
    const migrateImage = `cf-media-ci-api-migrate:${suffix}`;
    const builtMinioImage = `cf-media-ci-minio:${suffix}`;
    const selectedMinioImage = minioImage(fixtureFolder, builtMinioImage);
    docker([
      "build",
      "--file",
      resolve(apiContext.destination, "infrastructure/api/Dockerfile"),
      "--build-arg",
      `SOURCE_REVISION=${revision}`,
      "--target",
      "build",
      "--tag",
      apiBuildImage,
      apiContext.destination,
    ]);
    docker([
      "build",
      "--file",
      resolve(apiContext.destination, "infrastructure/api/Dockerfile"),
      "--build-arg",
      `SOURCE_REVISION=${revision}`,
      "--target",
      "api-migrate",
      "--tag",
      migrateImage,
      apiContext.destination,
    ]);
    composeFile = resolve(fixtureFolder, "compose.json");
    await writeFile(
      composeFile,
      composeFixture({
        project,
        apiBuildImage,
        migrateImage,
        minioImage: selectedMinioImage,
        folder: fixtureFolder,
      }),
      { flag: "wx", mode: 0o600 },
    );
    compose(project, composeFile, [
      "up",
      "--detach",
      "--wait",
      "postgres",
      "redis",
      "minio",
    ]);
    compose(project, composeFile, ["run", "--rm", "--no-deps", "minio-init"]);
    compose(project, composeFile, ["run", "--rm", "--no-deps", "api-migrate"]);
    const migrations = migrationCount(project, composeFile);
    compose(project, composeFile, ["run", "--rm", "--no-deps", "api-migrate"]);
    assert.equal(migrationCount(project, composeFile), migrations);
    compose(project, composeFile, ["run", "--rm", "--no-deps", "api-test"]);
    console.log(
      JSON.stringify({
        result: "CI_MEDIA_API_GATE_OK",
        revision,
        project,
        migrations,
        queueDisabled: false,
        disabledExternalFlags,
      }),
    );
  } finally {
    if (composeFile) cleanupEvidence = cleanup(project, composeFile);
    if (fixtureFolder)
      await rm(fixtureFolder, { recursive: true, force: true });
    if (cleanupEvidence)
      console.log(JSON.stringify({ cleanup: cleanupEvidence }));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv.length,
    3,
    "Usage: node scripts/ci-media-api-gate.mjs FULL_COMMIT_SHA",
  );
  await runGate(process.argv[2]);
}
