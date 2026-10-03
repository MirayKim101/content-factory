import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateWebDatabaseMetadata,
  validateWebSbom,
  validateWebScanReport,
  webEdgeScannerIsolationArgs,
} from "./web-edge-artifact-policy.mjs";

const now = Date.parse("2026-10-03T14:00:00Z");
const manifest = {
  configDigest: `sha256:${"a".repeat(64)}`,
  platform: "linux/amd64",
};
const alpineVersion = "fixture-alpine-version";
const osTarget = "fixture-image-archive.tar";
const caddyGoTarget = "usr/bin/caddy";
const sbomCreator = "Tool: syft-fixture";
const expectedCaddy = {
  name: "caddy",
  versionInfo: "2.11.7",
  sourceInfoNeedle: "Go binary",
  binaryFileName: "/usr/bin/caddy",
};

function report() {
  return {
    Trivy: { Version: "0.75.0" },
    SchemaVersion: 2,
    ArtifactType: "container_image",
    Metadata: {
      ImageID: manifest.configDigest,
      ImageConfig: { os: "linux", architecture: "amd64" },
      OS: { Family: "alpine", Name: alpineVersion, EOSL: false },
    },
    Results: [
      {
        Target: osTarget,
        Class: "os-pkgs",
        Type: "alpine",
      },
      {
        Target: caddyGoTarget,
        Class: "lang-pkgs",
        Type: "gobinary",
      },
    ],
  };
}

function sbom() {
  return {
    spdxVersion: "SPDX-2.3",
    creationInfo: { creators: [sbomCreator] },
    packages: [
      {
        name: "caddy",
        versionInfo: "2.11.7",
        sourceInfo: "cataloged from Go binary /usr/bin/caddy",
      },
      { name: "musl", versionInfo: "fixture", sourceInfo: "Alpine package DB" },
    ],
    files: [
      { fileName: "/usr/bin/caddy" },
      { fileName: "/usr/share/caddy/index.html" },
    ],
  };
}

test("fresh vulnerability metadata has an exact schema and 24-hour boundary", () => {
  assert.equal(
    validateWebDatabaseMetadata(
      { Version: 2, UpdatedAt: "2026-10-02T14:00:00Z" },
      now,
    ).ageMs,
    86400000,
  );
  for (const metadata of [
    { Version: 1, UpdatedAt: "2026-10-03T14:00:00Z" },
    { Version: 2, UpdatedAt: "2026-10-02T13:59:59Z" },
    { Version: 2, UpdatedAt: "2026-10-03T14:00:01Z" },
    { Version: 2, UpdatedAt: "malformed" },
  ]) {
    assert.throws(() => validateWebDatabaseMetadata(metadata, now));
  }
});

test("all scanner severities are parsed and every non-LOW finding blocks", () => {
  const input = report();
  input.Results[0].Vulnerabilities = [
    "LOW",
    "UNKNOWN",
    "MEDIUM",
    "HIGH",
    "CRITICAL",
  ].map((Severity) => ({
    Severity,
    VulnerabilityID: "CVE-fixture",
    PkgName: "fixture",
    InstalledVersion: "1.0",
  }));
  input.Results[1].Vulnerabilities = [
    {
      Severity: "HIGH",
      VulnerabilityID: "CVE-caddy-fixture",
      PkgName: "caddy",
      InstalledVersion: "2.11.7",
    },
  ];
  assert.deepEqual(
    validateWebScanReport(
      input,
      manifest,
      alpineVersion,
      osTarget,
      caddyGoTarget,
    ).map((finding) => finding.Severity),
    ["UNKNOWN", "MEDIUM", "HIGH", "CRITICAL", "HIGH"],
  );
  for (const Severity of [undefined, "", "MODERATE", "high"]) {
    input.Results[0].Vulnerabilities = [
      {
        Severity,
        VulnerabilityID: "CVE-fixture",
        PkgName: "fixture",
        InstalledVersion: "1.0",
      },
    ];
    assert.throws(() =>
      validateWebScanReport(
        input,
        manifest,
        alpineVersion,
        osTarget,
        caddyGoTarget,
      ),
    );
  }
});

test("unknown schemas, malformed findings, missing platform and extra inventories fail closed", () => {
  for (const mutate of [
    (value) => {
      value.Trivy.Version = "unexpected";
    },
    (value) => {
      value.SchemaVersion = 3;
    },
    (value) => {
      value.Metadata.ImageID = "wrong";
    },
    (value) => {
      delete value.Metadata.ImageConfig;
    },
    (value) => {
      value.Metadata.ImageConfig.architecture = "arm64";
    },
    (value) => {
      value.Metadata.OS.Family = "debian";
    },
    (value) => {
      value.Results = [];
    },
    (value) => {
      value.Results.pop();
    },
    (value) => {
      value.Results.push({ Class: "lang-pkgs", Type: "node-pkg" });
    },
    (value) => {
      value.Results[1].Type = "node-pkg";
    },
    (value) => {
      value.Results[0].Target = "wrong";
    },
    (value) => {
      value.Results[1].Target = "wrong";
    },
    (value) => {
      value.Results[0].Vulnerabilities = {};
    },
    (value) => {
      value.Results[0].Vulnerabilities = [{ Severity: "LOW" }];
    },
    (value) => {
      value.Results[0].ExperimentalModifiedFindings = [{}];
    },
    (value) => {
      value.Results[1].Vulnerabilities = [{ Severity: "HIGH" }];
    },
  ]) {
    const input = report();
    mutate(input);
    assert.throws(() =>
      validateWebScanReport(
        input,
        manifest,
        alpineVersion,
        osTarget,
        caddyGoTarget,
      ),
    );
  }
  assert.throws(() =>
    validateWebScanReport(
      report(),
      { ...manifest, platform: "linux/arm64" },
      alpineVersion,
      osTarget,
      caddyGoTarget,
    ),
  );
  assert.throws(() =>
    validateWebScanReport(report(), manifest, alpineVersion, "", caddyGoTarget),
  );
  assert.throws(() =>
    validateWebScanReport(report(), manifest, alpineVersion, osTarget),
  );
});

test("SBOM requires exactly one calibrated Caddy Go binary and rejects injected runtime/build content", () => {
  assert.equal(
    validateWebSbom(sbom(), expectedCaddy, sbomCreator).name,
    "caddy",
  );
  for (const mutate of [
    (value) => {
      value.spdxVersion = "SPDX-3.0";
    },
    (value) => {
      value.creationInfo.creators = [];
    },
    (value) => {
      value.packages = value.packages.filter((item) => item.name !== "caddy");
    },
    (value) => {
      value.packages.push({ ...value.packages[0] });
    },
    (value) => {
      value.packages[0].versionInfo = "2.11.6";
    },
    (value) => {
      delete value.packages[0].sourceInfo;
    },
    (value) => {
      value.packages.push({
        name: "node",
        versionInfo: "24",
        sourceInfo: "runtime",
      });
    },
    (value) => {
      value.files.push({ fileName: "/workspace/node_modules/nuxt/index.mjs" });
    },
    (value) => {
      value.files.push({ fileName: "/root/.cache/yarn/v6/cache" });
    },
    (value) => {
      value.files.push({ fileName: "/app/src/main.ts" });
    },
    (value) => {
      value.files.push({ fileName: "/usr/bin/gcc" });
    },
    (value) => {
      value.files.push({ fileName: "/usr/local/go/bin/go" });
    },
    (value) => {
      value.packages.push({
        name: "corepack",
        versionInfo: "fixture",
        sourceInfo: "build tool",
      });
    },
    (value) => {
      value.files = [];
    },
    (value) => {
      value.files.push({});
    },
  ]) {
    const input = sbom();
    mutate(input);
    assert.throws(() => validateWebSbom(input, expectedCaddy, sbomCreator));
  }
  const allowed = sbom();
  allowed.files.push({ fileName: "/usr/share/caddy/target.json" });
  assert.equal(
    validateWebSbom(allowed, expectedCaddy, sbomCreator).name,
    "caddy",
  );
  assert.throws(() =>
    validateWebSbom(
      sbom(),
      { ...expectedCaddy, versionInfo: "2.11.6" },
      sbomCreator,
    ),
  );
  assert.throws(() =>
    validateWebSbom(
      sbom(),
      { ...expectedCaddy, versionInfo: "2.11.8" },
      sbomCreator,
    ),
  );
  assert.throws(() => validateWebSbom(sbom(), expectedCaddy, ""));
});

test("edge scanner isolation mounts only owned artifact and DB read-only without network or socket", () => {
  const args = webEdgeScannerIsolationArgs(
    "/owned/web.oci.tar",
    "/owned/trivy-db",
  );
  assert.ok(args.includes("--pull=never"));
  assert.equal(
    args.some((value) => value.includes("docker.sock")),
    false,
  );
});
