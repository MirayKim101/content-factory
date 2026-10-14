import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectOciArchive } from "./artifact-scan-policy.mjs";
import {
  approvedInput,
  captureOutput,
  isolationArgs,
  sha256File,
} from "./scan-oci-artifact.mjs";
import {
  validateWebDatabaseMetadata,
  validateWebScanReport,
  validateWebSbom,
} from "./web-edge-artifact-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [archiveArgument, cacheArgument, revision] = process.argv.slice(2);
for (const input of [archiveArgument, cacheArgument]) {
  assert.equal(typeof input, "string");
  assert.equal(
    /(?:^|\/)(?:seanova(?:-new)?|dockerserver)(?:\/|$)/i.test(
      resolve(input).normalize("NFD").replace(/\p{M}/gu, ""),
    ),
    false,
  );
}
const archive = await approvedInput(archiveArgument);
const database = await approvedInput(resolve(cacheArgument, "db"));
const pins = JSON.parse(
  await readFile(new URL("./artifact-scan-pins.json", import.meta.url), "utf8"),
);
for (const scanner of [pins.trivy, pins.syft]) {
  const digests = JSON.parse(
    execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", scanner.image],
      { encoding: "utf8" },
    ),
  );
  assert.ok(digests.includes(scanner.image.replace(/:[^/:]+(?=@)/, "")));
}
const metadata = JSON.parse(
  await readFile(resolve(database, "metadata.json"), "utf8"),
);
validateWebDatabaseMetadata(metadata);
const oci = inspectOciArchive(archive, revision);
assert.equal(oci.manifests.length, 1);
const output = await mkdtemp(resolve(root, "tmp/web-edge-scan-"));
console.log(JSON.stringify({ output }));
const layout = resolve(output, "layout");
await mkdir(resolve(layout, "blobs/sha256"), { recursive: true });
async function capture(command, args, path, descriptor) {
  const file = await open(path, "wx", 0o600);
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
  const exited = new Promise((r, j) => {
    child.on("error", j);
    child.on("exit", (code, signal) => r({ code, signal }));
  });
  try {
    await captureOutput(child.stdout, file, descriptor);
    const result = await exited;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await file.close();
  }
}
const descriptors = new Map(
  [...oci.blobs, ...oci.layers].map((blob) => [
    `blobs/sha256/${blob.digest.slice(7)}`,
    blob,
  ]),
);
for (const entry of ["oci-layout", "index.json", ...descriptors.keys()]) {
  await capture(
    "tar",
    ["-xOf", archive, "--", entry],
    resolve(layout, entry),
    descriptors.get(entry),
  );
}
const initial = {
  archive: await sha256File(archive),
  database: await sha256File(resolve(database, "trivy.db")),
  metadata: await sha256File(resolve(database, "metadata.json")),
};
async function scan(args, path) {
  const name = `cf-web-edge-scan-${randomUUID()}`;
  try {
    await capture(
      "docker",
      [...args.slice(0, 1), "--name", name, ...args.slice(1)],
      resolve(output, path),
    );
  } finally {
    execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
  }
}
await scan(
  [
    ...isolationArgs(archive, database),
    "--env",
    "SYFT_CHECK_FOR_APP_UPDATE=false",
    "--env",
    "XDG_CACHE_HOME=/cache",
    pins.syft.image,
    "--from",
    "oci-archive",
    "/input/artifact.oci.tar",
    "--platform",
    "linux/amd64",
    "--output",
    "spdx-json",
  ],
  "sbom.spdx.json",
);
const freshness = validateWebDatabaseMetadata(metadata);
const scanStartedAt = new Date().toISOString();
await scan(
  [
    ...isolationArgs(layout, database, true),
    pins.trivy.image,
    "--cache-dir",
    "/cache",
    "--config",
    "/dev/null",
    "image",
    "--input",
    "/input/layout",
    "--platform",
    "linux/amd64",
    "--scanners",
    "vuln",
    "--ignore-unfixed=false",
    "--ignorefile",
    "",
    "--ignore-policy",
    "",
    "--offline-scan",
    "--skip-db-update",
    "--skip-java-db-update",
    "--skip-check-update",
    "--skip-version-check",
    "--disable-telemetry",
    "--no-progress",
    "--format",
    "json",
    "--output",
    "/dev/stdout",
  ],
  "trivy.json",
);
assert.equal(await sha256File(archive), initial.archive);
assert.equal(await sha256File(resolve(database, "trivy.db")), initial.database);
assert.equal(
  await sha256File(resolve(database, "metadata.json")),
  initial.metadata,
);
const report = JSON.parse(
  await readFile(resolve(output, "trivy.json"), "utf8"),
);
const sbom = JSON.parse(
  await readFile(resolve(output, "sbom.spdx.json"), "utf8"),
);
const proof = {
  sourceRevision: revision,
  oci,
  initial,
  database: freshness,
  scanStartedAt,
  scanners: pins,
  sbomSha256: await sha256File(resolve(output, "sbom.spdx.json")),
  reportSha256: await sha256File(resolve(output, "trivy.json")),
  promotionApproved: false,
  artifactGatePassed: false,
};
try {
  const findings = validateWebScanReport(
    report,
    oci.manifests[0],
    "3.23.6",
    "/input/layout (alpine 3.23.6)",
    "usr/bin/caddy",
  );
  validateWebSbom(
    sbom,
    {
      name: "github.com/caddyserver/caddy/v2",
      versionInfo: "v2.11.7",
      binaryFileName: "usr/bin/caddy",
      sourceInfoNeedle: "/usr/bin/caddy",
    },
    "Tool: syft-1.54.0",
  );
  proof.nonLowFindings = findings.length;
  proof.artifactGatePassed = findings.length === 0;
} catch (error) {
  proof.policyError = String(error);
}
await writeFile(
  resolve(output, "evidence.json"),
  `${JSON.stringify(proof, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    output,
    artifactGatePassed: proof.artifactGatePassed,
    nonLowFindings: proof.nonLowFindings,
    policyError: proof.policyError,
    promotionApproved: false,
  }),
);
process.exitCode = proof.artifactGatePassed ? 0 : 1;
