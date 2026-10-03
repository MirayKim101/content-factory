import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  sha256,
  validateManifest,
  verifyFiles,
} from "./diagnostic-pair-recovery.mjs";

const bytes = Buffer.from("diagnostic object");
const key = "sources/fixture/source.mp4";
function manifest() {
  const object = {
    key,
    filename: `${sha256(key)}.bin`,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    metadata: { sha256: sha256(bytes) },
    contentType: "video/mp4",
    etag: '"fixture"',
  };
  return {
    version: 1,
    diagnosticOnly: true,
    promotionApproved: false,
    sourceProject: "cf-api-proof-20261003",
    sourceRevision: "a".repeat(40),
    databaseSha256: sha256("dump"),
    databaseState: {
      sha256: sha256("state"),
      migrations: 45,
      unvalidatedConstraints: 0,
    },
    objects: [object],
    readyArtifacts: [
      {
        objectKey: key,
        sha256: object.sha256,
        sizeBytes: String(bytes.length),
        contentType: "video/mp4",
        storageVersion: null,
      },
    ],
  };
}

test("pair manifest requires a complete matching non-versioned diagnostic recovery unit", () => {
  assert.equal(validateManifest(manifest()).objects.length, 1);
  for (const mutate of [
    (m) => {
      m.promotionApproved = true;
    },
    (m) => {
      m.diagnosticOnly = false;
    },
    (m) => {
      m.sourceProject = "working";
    },
    (m) => {
      m.objects = [];
    },
    (m) => {
      m.objects.push(m.objects[0]);
    },
    (m) => {
      m.objects[0].filename = "../unsafe";
    },
    (m) => {
      m.objects[0].key = "sources/../unsafe";
    },
    (m) => {
      m.objects[0].storageVersion = "old-version";
    },
    (m) => {
      m.readyArtifacts[0].sha256 = "b".repeat(64);
    },
    (m) => {
      m.readyArtifacts[0].objectKey = "missing";
    },
    (m) => {
      m.databaseState.migrations = 44;
    },
    (m) => {
      m.databaseState.unvalidatedConstraints = 1;
    },
  ]) {
    const input = manifest();
    mutate(input);
    assert.throws(() => validateManifest(input));
  }
});

test("missing/corrupt/mismatched dump or object files fail before restore writes", async () => {
  const folder = await mkdtemp(resolve("tmp/pair-policy-test-"));
  try {
    const input = manifest();
    await mkdir(resolve(folder, "objects"));
    await writeFile(resolve(folder, "database.dump"), "dump");
    const objectPath = resolve(folder, "objects", input.objects[0].filename);
    await assert.rejects(verifyFiles(folder, input));
    await writeFile(objectPath, bytes);
    await verifyFiles(folder, input);
    await writeFile(objectPath, Buffer.alloc(bytes.length));
    await assert.rejects(verifyFiles(folder, input), /checksum/);
    await writeFile(objectPath, bytes);
    await writeFile(resolve(folder, "database.dump"), "wrong dump");
    await assert.rejects(verifyFiles(folder, input), /recovery pair/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("symlinked snapshot files are rejected without following their target", async () => {
  const folder = await mkdtemp(resolve("tmp/pair-link-test-"));
  try {
    const input = manifest();
    await mkdir(resolve(folder, "objects"));
    await writeFile(resolve(folder, "database.dump"), "dump");
    await symlink(
      "/does-not-exist",
      resolve(folder, "objects", input.objects[0].filename),
    );
    await assert.rejects(verifyFiles(folder, input));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
