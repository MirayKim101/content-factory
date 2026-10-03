import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  inspectOciArchive,
  validateDatabaseMetadata,
  validateScanReport,
} from "./artifact-scan-policy.mjs";
import { approvedInput, isolationArgs } from "./scan-oci-artifact.mjs";

const revision = "a".repeat(40);
const now = Date.parse("2026-10-03T13:00:00Z");
const manifest = { configDigest: `sha256:${"b".repeat(64)}` };
const report = () => ({
  Trivy: { Version: "0.75.0" },
  SchemaVersion: 2,
  ArtifactType: "container_image",
  Metadata: {
    ImageID: manifest.configDigest,
    OS: { Family: "debian", Name: "12.14", EOSL: false },
  },
  Results: [
    { Class: "os-pkgs", Type: "debian" },
    { Class: "lang-pkgs", Type: "node-pkg" },
  ],
});

test("database accepts only supported, valid, nonfuture timestamps within 24 hours", () => {
  assert.equal(
    validateDatabaseMetadata(
      { Version: 2, UpdatedAt: "2026-10-02T13:00:00Z" },
      now,
    ).ageMs,
    86400000,
  );
  for (const value of [
    undefined,
    "bad",
    "2026-02-30T13:00:00Z",
    "2026-10-03T13:00:01Z",
    "2026-10-02T12:59:59Z",
    "2026-10-03T13:00:00+01:00",
  ]) {
    assert.throws(() =>
      validateDatabaseMetadata({ Version: 2, UpdatedAt: value }, now),
    );
  }
  assert.throws(() =>
    validateDatabaseMetadata(
      { Version: 1, UpdatedAt: "2026-10-03T13:00:00Z" },
      now,
    ),
  );
});

test("unknown and medium-or-higher findings block; low alone is recognized", () => {
  const input = report();
  input.Results[1].Vulnerabilities = [
    "LOW",
    "UNKNOWN",
    "MEDIUM",
    "HIGH",
    "CRITICAL",
  ].map((Severity) => ({
    Severity,
    VulnerabilityID: "CVE-fixture",
    PkgName: "fixture",
    InstalledVersion: "1.0.0",
  }));
  assert.deepEqual(
    validateScanReport(input, manifest).map((item) => item.Severity),
    ["UNKNOWN", "MEDIUM", "HIGH", "CRITICAL"],
  );
  for (const Severity of [undefined, "", "MODERATE", "high"]) {
    input.Results[1].Vulnerabilities = [
      {
        Severity,
        VulnerabilityID: "CVE-fixture",
        PkgName: "fixture",
        InstalledVersion: "1.0.0",
      },
    ];
    assert.throws(() => validateScanReport(input, manifest));
  }
});

test("empty, unsupported, mismatched or incomplete scan inventory cannot pass", () => {
  assert.deepEqual(validateScanReport(report(), manifest), []);
  const omittedFalse = report();
  delete omittedFalse.Metadata.OS.EOSL;
  assert.deepEqual(validateScanReport(omittedFalse, manifest), []);
  for (const mutate of [
    (r) => {
      r.Trivy.Version = "unexpected";
    },
    (r) => {
      r.Results[0].Vulnerabilities = {};
    },
    (r) => {
      r.Results[1].ExperimentalModifiedFindings = [{ suppressed: true }];
    },
    (r) => {
      r.Results[1].Vulnerabilities = [null];
    },
    (r) => {
      r.Metadata.OS.EOSL = "false";
    },
    (r) => {
      r.SchemaVersion = 3;
    },
    (r) => {
      r.Metadata.ImageID = "wrong";
    },
    (r) => {
      r.Results = [];
    },
    (r) => {
      r.Results.pop();
    },
    (r) => {
      r.Results.shift();
    },
    (r) => {
      r.Metadata.OS.EOSL = true;
    },
    (r) => {
      r.Metadata.OS.Family = "unknown";
    },
  ]) {
    const input = report();
    mutate(input);
    assert.throws(() => validateScanReport(input, manifest));
  }
});

test("scanner isolation has no writable host mounts, network, privileges or Docker socket", () => {
  const args = isolationArgs("/owned/image.tar", "/owned/database");
  assert.ok(args.includes("--pull=never"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  assert.ok(args.includes("--read-only"));
  const mounts = args.filter((_, index) => args[index - 1] === "--mount");
  assert.equal(mounts.length, 2);
  assert.ok(mounts.every((value) => value.endsWith(",readonly")));
  assert.equal(
    mounts.some((value) => value.includes("target=/output")),
    false,
  );
  assert.equal(
    args.some((value) => /docker\.sock|--privileged/.test(value)),
    false,
  );
});

test("input boundaries reject protected paths, external paths and mount delimiters before access", async () => {
  for (const path of [
    "/outside/artifact.tar",
    "tmp/Seanova/a",
    "tmp/dockerServer/a",
    "tmp/Seanova-new/a",
    "tmp/.idea/a",
    "tmp/a,b",
    "tmp/a\nb",
  ]) {
    await assert.rejects(approvedInput(path));
  }
});

function fixture(options, run) {
  const folder = mkdtempSync(resolve("tmp/artifact-policy-test-"));
  try {
    mkdirSync(resolve(folder, "blobs/sha256"), { recursive: true });
    const descriptor = (value, mediaType) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const hash = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(resolve(folder, "blobs/sha256", hash), bytes);
      return { digest: `sha256:${hash}`, size: bytes.length, mediaType };
    };
    const imageType = "application/vnd.oci.image.manifest.v1+json";
    const indexType = "application/vnd.oci.image.index.v1+json";
    const config = descriptor(
      {
        os: "linux",
        architecture: "amd64",
        config: {
          Labels: {
            "org.opencontainers.image.revision": options.revision ?? revision,
            "io.content-factory.promotion":
              "blocked-until-all-release-gates-pass",
          },
        },
      },
      "application/vnd.oci.image.config.v1+json",
    );
    const layer = descriptor(
      { content: "fixture" },
      "application/vnd.oci.image.layer.v1.tar",
    );
    const image = {
      ...descriptor(
        { schemaVersion: 2, mediaType: imageType, config, layers: [layer] },
        imageType,
      ),
      platform: { os: "linux", architecture: options.architecture ?? "amd64" },
    };
    const subject = options.badSubject ? "0".repeat(64) : image.digest.slice(7);
    const statement = descriptor(
      { subject: [{ digest: { sha256: subject } }] },
      "application/vnd.in-toto+json",
    );
    const attestation = {
      ...descriptor(
        { schemaVersion: 2, mediaType: imageType, config, layers: [statement] },
        imageType,
      ),
      platform: { os: "unknown", architecture: "unknown" },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": image.digest,
      },
    };
    writeFileSync(
      resolve(folder, "oci-layout"),
      JSON.stringify({ imageLayoutVersion: "1.0.0" }),
    );
    writeFileSync(
      resolve(folder, "index.json"),
      JSON.stringify({
        schemaVersion: 2,
        mediaType: indexType,
        manifests: options.noAttestation ? [image] : [image, attestation],
      }),
    );
    if (options.corrupt)
      writeFileSync(
        resolve(folder, "blobs/sha256", config.digest.slice(7)),
        "bad",
      );
    const archive = resolve(folder, "fixture.tar");
    execFileSync("tar", [
      "-cf",
      archive,
      "-C",
      folder,
      "oci-layout",
      "index.json",
      "blobs",
    ]);
    run(archive);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("OCI metadata binds platform, revision, provenance and content hashes", () => {
  fixture({}, (archive) => {
    const result = inspectOciArchive(archive, revision);
    assert.equal(result.manifests.length, 1);
    assert.equal(result.attestations[0].subject, result.manifests[0].digest);
    assert.equal(result.layers.length, 1);
  });
  for (const options of [
    { architecture: "arm64" },
    { revision: "c".repeat(40) },
    { noAttestation: true },
    { badSubject: true },
    { corrupt: true },
  ]) {
    fixture(options, (archive) =>
      assert.throws(() => inspectOciArchive(archive, revision)),
    );
  }
});
