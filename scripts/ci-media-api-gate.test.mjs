import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  assertFixturePath,
  assertOwnedProject,
  composeFixture,
  diagnosticEnvironment,
  minioBuildPins,
  ownedProject,
  validateRevision,
} from "./ci-media-api-gate.mjs";

const revision = "a".repeat(40);

test("hosted MinIO build pins both bases and verifies source commits before executing Go", async () => {
  const dockerfile = await readFile(
    new URL("../infrastructure/minio/Dockerfile", import.meta.url),
    "utf8",
  );
  for (const [name, image] of [
    ["GO_IMAGE", minioBuildPins.goImage],
    ["RUNTIME_IMAGE", minioBuildPins.runtimeImage],
  ]) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/);
    assert.ok(dockerfile.includes(`ARG ${name}=${image}`));
  }
  for (const commit of [
    minioBuildPins.minioRevision,
    minioBuildPins.mcRevision,
  ]) {
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.ok(
      dockerfile.includes(`test "$(git rev-parse HEAD)" = '${commit}'`),
    );
  }
  assert.ok(
    dockerfile.indexOf(minioBuildPins.minioRevision) <
      dockerfile.indexOf("MINIO_RELEASE=RELEASE go run"),
  );
  assert.ok(
    dockerfile.indexOf(minioBuildPins.mcRevision) <
      dockerfile.indexOf("MC_RELEASE=RELEASE go run"),
  );
});

test("requires a full immutable revision and a bounded project namespace", () => {
  assert.equal(validateRevision(revision), revision);
  assert.equal(ownedProject(revision, 42), "cf-media-ci-aaaaaaaaaaaa-42");
  for (const value of ["main", "A".repeat(40), "a".repeat(39)]) {
    assert.throws(() => validateRevision(value));
  }
  for (const project of [
    "content-factory",
    "cf-media-ci-abc-0",
    "cf-media-ci-aaaaaaaaaaaa-0",
  ]) {
    assert.throws(() => assertOwnedProject(project));
  }
});

test("allows only committed test and MinIO fixture inputs", () => {
  assert.equal(
    assertFixturePath("apps/api/test/media-pipeline.api.integration.spec.ts"),
    "apps/api/test/media-pipeline.api.integration.spec.ts",
  );
  for (const path of [
    "apps/api/src/main.ts",
    "apps/api/test/../src/main.ts",
    "Seanova/secret",
    "DockerServer/secret",
  ]) {
    assert.throws(() => assertFixturePath(path));
  }
});

test("generated Compose fixture has no host ports, enables BullMQ, and disables external admissions", () => {
  const document = JSON.parse(
    composeFixture({
      project: ownedProject(revision, 42),
      apiBuildImage: "cf-media-ci-api-build:test",
      migrateImage: "cf-media-ci-api-migrate:test",
      minioImage:
        "sha256:eea60ca39c6c3b36cff6bbd624211ba1db49a8bc0d438d3d6ddc65bcef8b563f",
      folder: "/tmp/fixture",
    }),
  );
  assert.equal(document.networks.proof.internal, true);
  for (const service of Object.values(document.services)) {
    assert.equal("ports" in service, false);
  }
  assert.equal(
    document.services["api-test"].environment.MEDIA_QUEUE_DISABLED,
    "0",
  );
  assert.deepEqual(Object.values(diagnosticEnvironment()), Array(16).fill("0"));
  assert.equal(document.services["api-test"].user, "1000:1000");
  assert.ok(
    document.services["api-test"].volumes.every((volume) =>
      volume.endsWith(":ro"),
    ),
  );
});
