import assert from "node:assert/strict";

import { isolationArgs } from "./scan-oci-artifact.mjs";
import { validateDatabaseMetadata } from "./artifact-scan-policy.mjs";

const scannerVersion = "0.75.0";
const allowedSeverities = new Set([
  "UNKNOWN",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);
const forbiddenPathSegments = new Set([
  ".cache",
  ".nuxt",
  "app",
  "cache",
  "cargo",
  "cmake",
  "corepack",
  "curl",
  "g++",
  "gcc",
  "git",
  "go",
  "make",
  "nitro",
  "node",
  "node_modules",
  "npm",
  "nuxt",
  "pip",
  "pip3",
  "pnpm",
  "python",
  "python3",
  "root",
  "rustc",
  "src",
  "tar",
  "tsx",
  "typescript",
  "vite",
  "wget",
  "workspace",
  "yarn",
  "zip",
]);

function hasForbiddenPathSegment(value) {
  return value
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .some((segment) => forbiddenPathSegments.has(segment));
}

function hasForbiddenPackageName(name) {
  return name
    .toLowerCase()
    .split(/[/@]/)
    .filter(Boolean)
    .some((segment) => forbiddenPathSegments.has(segment));
}

function validateInventory(inventory, expected) {
  assert.equal(inventory?.Class, expected.Class);
  assert.equal(inventory?.Type, expected.Type);
  assert.equal(inventory?.Target, expected.Target);
  assert.ok(
    inventory.Vulnerabilities === undefined ||
      Array.isArray(inventory.Vulnerabilities),
    "Malformed vulnerability catalog",
  );
  assert.ok(
    inventory.ExperimentalModifiedFindings === undefined ||
      (Array.isArray(inventory.ExperimentalModifiedFindings) &&
        inventory.ExperimentalModifiedFindings.length === 0),
    "Suppressed findings are forbidden",
  );

  const findings = inventory.Vulnerabilities ?? [];
  for (const finding of findings) {
    for (const field of ["VulnerabilityID", "PkgName", "InstalledVersion"]) {
      assert.ok(
        typeof finding?.[field] === "string" && finding[field].length > 0,
        "Malformed vulnerability finding",
      );
    }
    assert.ok(
      allowedSeverities.has(finding.Severity),
      "Unclassified vulnerability severity",
    );
  }
  return findings;
}

export function validateWebDatabaseMetadata(metadata, now = Date.now()) {
  return validateDatabaseMetadata(metadata, now);
}

export function validateWebScanReport(
  report,
  manifest,
  expectedAlpineVersion,
  expectedOsTarget,
  expectedCaddyGoTarget,
) {
  assert.match(manifest?.configDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest?.platform, "linux/amd64");
  assert.equal(typeof expectedAlpineVersion, "string");
  assert.ok(expectedAlpineVersion.length > 0);
  assert.equal(typeof expectedOsTarget, "string");
  assert.ok(expectedOsTarget.length > 0);
  assert.equal(typeof expectedCaddyGoTarget, "string");
  assert.ok(expectedCaddyGoTarget.length > 0);
  assert.equal(
    report?.Trivy?.Version,
    scannerVersion,
    "Unexpected scanner version",
  );
  assert.equal(
    report.SchemaVersion,
    2,
    "Unsupported vulnerability report schema",
  );
  assert.equal(report.ArtifactType, "container_image");
  assert.equal(report.Metadata?.ImageID, manifest.configDigest);
  assert.equal(report.Metadata?.ImageConfig?.os, "linux");
  assert.equal(report.Metadata?.ImageConfig?.architecture, "amd64");
  assert.equal(report.Metadata?.OS?.Family, "alpine");
  assert.equal(report.Metadata.OS.Name, expectedAlpineVersion);
  assert.ok(
    report.Metadata.OS.EOSL === undefined || report.Metadata.OS.EOSL === false,
    "End-of-life or malformed OS support status",
  );
  assert.ok(Array.isArray(report.Results) && report.Results.length === 2);
  const alpine = report.Results.find(
    (inventory) =>
      inventory?.Class === "os-pkgs" && inventory.Type === "alpine",
  );
  const caddyGo = report.Results.find(
    (inventory) =>
      inventory?.Class === "lang-pkgs" && inventory.Type === "gobinary",
  );
  assert.ok(alpine, "Missing Alpine OS package inventory");
  assert.ok(caddyGo, "Missing Caddy Go-binary inventory");
  const alpineFindings = validateInventory(alpine, {
    Class: "os-pkgs",
    Type: "alpine",
    Target: expectedOsTarget,
  });
  const caddyFindings = validateInventory(caddyGo, {
    Class: "lang-pkgs",
    Type: "gobinary",
    Target: expectedCaddyGoTarget,
  });
  const findings = [...alpineFindings, ...caddyFindings];
  return findings.filter((finding) => finding.Severity !== "LOW");
}

export function validateWebSbom(sbom, expectedCaddy, expectedSbomCreator) {
  assert.deepEqual(Object.keys(expectedCaddy).sort(), [
    "binaryFileName",
    "name",
    "sourceInfoNeedle",
    "versionInfo",
  ]);
  for (const value of Object.values(expectedCaddy)) {
    assert.ok(typeof value === "string" && value.length > 0);
  }
  assert.match(expectedCaddy.versionInfo, /^v?2\.11\.7$/);
  assert.ok(expectedCaddy.binaryFileName.startsWith("/"));
  assert.equal(typeof expectedSbomCreator, "string");
  assert.ok(expectedSbomCreator.length > 0);
  assert.equal(sbom?.spdxVersion, "SPDX-2.3");
  assert.ok(Array.isArray(sbom.creationInfo?.creators));
  assert.ok(sbom.creationInfo.creators.includes(expectedSbomCreator));
  assert.ok(Array.isArray(sbom.packages) && sbom.packages.length > 0);
  assert.ok(Array.isArray(sbom.files) && sbom.files.length > 0);
  const caddy = sbom.packages.filter(
    (item) =>
      item?.name === expectedCaddy.name &&
      item.versionInfo === expectedCaddy.versionInfo &&
      typeof item.sourceInfo === "string" &&
      item.sourceInfo.includes(expectedCaddy.sourceInfoNeedle),
  );
  assert.equal(
    caddy.length,
    1,
    "Exactly one Caddy Go binary inventory is required",
  );
  assert.ok(
    sbom.files.some((file) => file?.fileName === expectedCaddy.binaryFileName),
    "Caddy Go-binary file inventory is required",
  );
  for (const item of sbom.packages) {
    assert.equal(typeof item?.name, "string");
    assert.equal(hasForbiddenPackageName(item.name), false);
  }
  for (const file of sbom.files) {
    assert.equal(typeof file?.fileName, "string");
    assert.equal(hasForbiddenPathSegment(file.fileName), false);
  }
  return caddy[0];
}

export function webEdgeScannerIsolationArgs(archive, database) {
  const args = isolationArgs(archive, database);
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("no-new-privileges"));
  const mounts = args.filter((_, index) => args[index - 1] === "--mount");
  assert.equal(mounts.length, 2);
  assert.ok(mounts.every((mount) => mount.endsWith(",readonly")));
  assert.equal(
    args.some((value) => /docker\.sock|--privileged/.test(value)),
    false,
  );
  return args;
}
