import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export function validateDatabaseMetadata(metadata, now = Date.now()) {
  assert.equal(metadata.Version, 2, "Unsupported vulnerability DB schema");
  assert.equal(typeof metadata.UpdatedAt, "string");
  assert.match(
    metadata.UpdatedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/,
  );
  const updated = Date.parse(metadata.UpdatedAt);
  assert.ok(Number.isFinite(updated));
  assert.equal(
    new Date(updated).toISOString().slice(0, 19),
    metadata.UpdatedAt.slice(0, 19),
    "Invalid calendar timestamp",
  );
  assert.ok(updated <= now, "Future-dated vulnerability database");
  assert.ok(
    now - updated <= 86400000,
    "Vulnerability database is older than 24 hours",
  );
  return {
    updatedAt: metadata.UpdatedAt,
    ageMs: now - updated,
    schemaVersion: metadata.Version,
  };
}

const imageType = "application/vnd.oci.image.manifest.v1+json";
const indexType = "application/vnd.oci.image.index.v1+json";

export function inspectOciArchive(archive, expectedRevision) {
  assert.match(expectedRevision, /^[a-f0-9]{40}$/);
  const entry = (path) =>
    execFileSync("tar", ["-xOf", archive, "--", path], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10000,
    });
  assert.deepEqual(JSON.parse(entry("oci-layout")), {
    imageLayoutVersion: "1.0.0",
  });
  const blobs = new Map();
  const readDescriptor = (descriptor) => {
    assert.match(descriptor.digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(descriptor.size) &&
        descriptor.size > 0 &&
        descriptor.size <= 16 * 1024 * 1024,
    );
    const bytes = entry(`blobs/sha256/${descriptor.digest.slice(7)}`);
    assert.equal(bytes.length, descriptor.size);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      descriptor.digest.slice(7),
      "OCI descriptor checksum mismatch",
    );
    blobs.set(descriptor.digest, {
      digest: descriptor.digest,
      size: descriptor.size,
    });
    return JSON.parse(bytes);
  };
  const manifests = [];
  const attestations = [];
  const layers = new Map();
  const seen = new Set();
  const visit = (descriptor, depth = 0) => {
    assert.ok(depth < 5 && seen.size < 64, "Excessive OCI index nesting");
    assert.equal(
      seen.has(descriptor.digest),
      false,
      "Duplicate/cyclic OCI descriptor",
    );
    seen.add(descriptor.digest);
    const value = readDescriptor(descriptor);
    assert.equal(value.schemaVersion, 2);
    if (descriptor.mediaType === indexType) {
      assert.equal(value.mediaType, indexType);
      assert.ok(Array.isArray(value.manifests) && value.manifests.length > 0);
      for (const child of value.manifests) visit(child, depth + 1);
      return;
    }
    assert.equal(
      descriptor.mediaType,
      imageType,
      "Unsupported OCI descriptor type",
    );
    assert.equal(value.mediaType, imageType);
    if (
      descriptor.annotations?.["vnd.docker.reference.type"] ===
      "attestation-manifest"
    ) {
      assert.equal(descriptor.platform?.os, "unknown");
      assert.equal(descriptor.platform?.architecture, "unknown");
      assert.ok(Array.isArray(value.layers) && value.layers.length > 0);
      for (const layer of value.layers) {
        assert.equal(layer.mediaType, "application/vnd.in-toto+json");
        const statement = readDescriptor(layer);
        assert.ok(
          Array.isArray(statement.subject) && statement.subject.length > 0,
        );
        assert.ok(
          statement.subject.some(
            (subject) =>
              `sha256:${subject.digest?.sha256}` ===
              descriptor.annotations["vnd.docker.reference.digest"],
          ),
          "Attestation does not bind its subject",
        );
      }
      attestations.push({
        digest: descriptor.digest,
        subject: descriptor.annotations["vnd.docker.reference.digest"],
      });
      return;
    }
    const platform = descriptor.platform;
    // This first implementation deliberately supports one native platform.
    // Other platforms fail closed; no unscanned architecture is promoted.
    assert.equal(platform?.os, "linux");
    assert.equal(
      platform?.architecture,
      "amd64",
      "Unsupported artifact platform",
    );
    assert.equal(platform.variant, undefined);
    const config = readDescriptor(value.config);
    assert.equal(config.os, "linux");
    assert.equal(config.architecture, "amd64");
    assert.equal(
      config.config.Labels["org.opencontainers.image.revision"],
      expectedRevision,
    );
    assert.equal(
      config.config.Labels["io.content-factory.promotion"],
      "blocked-until-all-release-gates-pass",
    );
    assert.ok(Array.isArray(value.layers) && value.layers.length > 0);
    for (const layer of value.layers) {
      assert.match(layer.digest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(
        Number.isSafeInteger(layer.size) &&
          layer.size > 0 &&
          layer.size < 2 * 1024 ** 3,
      );
      assert.ok(
        [
          "application/vnd.oci.image.layer.v1.tar",
          "application/vnd.oci.image.layer.v1.tar+gzip",
          "application/vnd.oci.image.layer.v1.tar+zstd",
        ].includes(layer.mediaType),
      );
      const previous = layers.get(layer.digest);
      if (previous) assert.deepEqual(layer, previous);
      layers.set(layer.digest, layer);
      blobs.set(layer.digest, { digest: layer.digest, size: layer.size });
    }
    manifests.push({
      digest: descriptor.digest,
      platform: "linux/amd64",
      configDigest: value.config.digest,
      sourceRevision: expectedRevision,
    });
  };
  const root = JSON.parse(entry("index.json"));
  assert.equal(root.schemaVersion, 2);
  assert.equal(root.mediaType, indexType);
  assert.ok(Array.isArray(root.manifests) && root.manifests.length > 0);
  for (const descriptor of root.manifests) visit(descriptor);
  assert.equal(
    manifests.length,
    1,
    "Exactly one supported platform must be scanned",
  );
  assert.ok(
    attestations.length > 0,
    "BuildKit provenance attestation is required",
  );
  for (const attestation of attestations) {
    assert.ok(
      manifests.some((manifest) => manifest.digest === attestation.subject),
      "Orphan provenance attestation",
    );
  }
  return {
    manifests,
    attestations,
    layers: [...layers.values()],
    blobs: [...blobs.values()],
  };
}

export function validateScanReport(report, manifest) {
  assert.equal(report.Trivy?.Version, "0.75.0", "Unexpected scanner version");
  assert.equal(
    report.SchemaVersion,
    2,
    "Unsupported vulnerability report schema",
  );
  assert.equal(report.ArtifactType, "container_image");
  assert.equal(
    report.Metadata?.ImageID,
    manifest.configDigest,
    "Scanner analyzed a different image configuration",
  );
  assert.ok(
    Array.isArray(report.Results) && report.Results.length > 0,
    "No vulnerability catalog was produced",
  );
  assert.equal(
    report.Metadata?.OS?.Family,
    "debian",
    "Unsupported OS inventory",
  );
  // Trivy v0.75.0 OS.Eosl has json:"EOSL,omitempty": false is omitted.
  // https://github.com/aquasecurity/trivy/blob/v0.75.0/pkg/fanal/types/artifact.go
  assert.ok(
    report.Metadata.OS.EOSL === undefined || report.Metadata.OS.EOSL === false,
    "End-of-life or malformed OS support status",
  );
  assert.match(
    report.Metadata.OS.Name,
    /^12(?:\.\d+)?$/,
    "Unsupported Debian release",
  );
  assert.ok(report.Results.some((result) => result.Class === "os-pkgs"));
  assert.ok(
    report.Results.some(
      (result) => result.Class === "lang-pkgs" && result.Type === "node-pkg",
    ),
  );
  const findings = report.Results.flatMap((result) => {
    assert.ok(
      (result.Class === "os-pkgs" && result.Type === "debian") ||
        (result.Class === "lang-pkgs" && result.Type === "node-pkg"),
      "Unsupported scan inventory",
    );
    assert.ok(
      result.Vulnerabilities === undefined ||
        Array.isArray(result.Vulnerabilities),
      "Malformed vulnerability catalog",
    );
    assert.ok(
      result.ExperimentalModifiedFindings === undefined ||
        (Array.isArray(result.ExperimentalModifiedFindings) &&
          result.ExperimentalModifiedFindings.length === 0),
      "Suppressed findings are forbidden",
    );
    return result.Vulnerabilities ?? [];
  });
  for (const finding of findings) {
    for (const field of ["VulnerabilityID", "PkgName", "InstalledVersion"]) {
      assert.ok(
        typeof finding?.[field] === "string" && finding[field].length > 0,
        "Malformed vulnerability finding",
      );
    }
    assert.ok(
      ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(
        finding.Severity,
      ),
      "Unclassified vulnerability severity",
    );
  }
  return findings.filter((finding) => finding.Severity !== "LOW");
}
