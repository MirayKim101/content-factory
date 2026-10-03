import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectOciArchive,
  validateDatabaseMetadata,
  validateScanReport,
} from "./artifact-scan-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pins = JSON.parse(
  await readFile(new URL("./artifact-scan-pins.json", import.meta.url), "utf8"),
);
assert.equal(pins.databaseMaxAgeMs, 86400000);
assert.equal(pins.version, 1);
for (const scanner of [pins.trivy, pins.syft]) {
  assert.match(scanner.image, /@sha256:[a-f0-9]{64}$/);
}

export async function approvedInput(path) {
  const absolute = resolve(path);
  assert.equal(/[\r\n,]/.test(absolute), false, "Invalid bind mount path");
  const temporary = resolve(root, "tmp");
  assert.ok(
    absolute.startsWith(`${temporary}${sep}`),
    "Only owned temporary artifacts may be read",
  );
  const parts = relative(temporary, absolute).split(sep);
  assert.ok(
    parts.every(
      (part) =>
        part &&
        !/^(?:seanova(?:-new)?|dockerserver)$/i.test(part) &&
        !part.startsWith("."),
    ),
    "Forbidden input path",
  );
  let current = temporary;
  for (const part of [null, ...parts]) {
    if (part) current = resolve(current, part);
    const info = await lstat(current);
    assert.equal(
      info.isSymbolicLink(),
      false,
      "Symlinked artifact/cache paths are forbidden",
    );
  }
  return absolute;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function execute(command, args, timeoutMs = 300000, outputPath) {
  const output = outputPath ? await open(outputPath, "wx", 0o600) : undefined;
  let child;
  let timer;
  let forced;
  try {
    child = spawn(command, args, {
      stdio: ["ignore", output ? "pipe" : "inherit", "inherit"],
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      forced = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);
    const exited = new Promise((resolveExit) => {
      child.on("error", (error) => resolveExit({ error }));
      child.on("exit", (code, signal) => resolveExit({ code, signal }));
    });
    if (output) {
      let size = 0;
      for await (const chunk of child.stdout) {
        size += chunk.length;
        assert.ok(size <= 128 * 1024 ** 2, "Scanner output exceeded 128 MiB");
        await output.write(chunk);
      }
    }
    const result = await exited;
    if (result.error) throw result.error;
    assert.equal(result.signal, null, `${command} was terminated`);
    return result.code;
  } finally {
    clearTimeout(timer);
    clearTimeout(forced);
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await output?.close();
  }
}

async function verifyLayer(archive, layer) {
  const hash = createHash("sha256");
  let size = 0;
  const child = spawn(
    "tar",
    ["-xOf", archive, "--", `blobs/sha256/${layer.digest.slice(7)}`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exit = new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 && !signal
        ? resolveExit()
        : reject(new Error("Missing/corrupt OCI layer")),
    );
  });
  for await (const chunk of child.stdout) {
    size += chunk.length;
    hash.update(chunk);
  }
  await exit;
  assert.equal(size, layer.size, "OCI layer size mismatch");
  assert.equal(
    `sha256:${hash.digest("hex")}`,
    layer.digest,
    "OCI layer checksum mismatch",
  );
}

export function isolationArgs(archive, databaseDirectory, layout = false) {
  return [
    "run",
    "--pull=never",
    "--network",
    "none",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--workdir",
    "/tmp",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=1g,uid=1000,gid=1000,mode=0700",
    "--tmpfs",
    "/cache:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700",
    "--mount",
    `type=bind,source=${archive},target=${layout ? "/input/layout" : "/input/artifact.oci.tar"},readonly`,
    "--mount",
    `type=bind,source=${databaseDirectory},target=/cache/db,readonly`,
  ];
}

async function runScanner(args, imageArgs, output, filename) {
  assert.ok(["sbom.spdx.json", "trivy.json"].includes(filename));
  const name = `cf-artifact-scan-${randomUUID()}`;
  try {
    const code = await execute(
      "docker",
      [...args, "--name", name, ...imageArgs],
      300000,
      resolve(output, filename),
    );
    assert.equal(code, 0, "Scanner execution failed");
    return code;
  } finally {
    // Only the uniquely named container created by this invocation is removed.
    const code = await execute("docker", ["rm", "--force", name], 30000);
    assert.equal(code, 0, "Scanner container cleanup failed");
  }
}

export async function scanArtifact(archiveInput, cacheInput, expectedRevision) {
  // Fetching scanner tools belongs to the separate connected preparation step.
  for (const scanner of [pins.trivy, pins.syft]) {
    const digests = JSON.parse(
      execFileSync(
        "docker",
        [
          "image",
          "inspect",
          "--format",
          "{{json .RepoDigests}}",
          scanner.image,
        ],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
      ).toString(),
    );
    assert.ok(
      Array.isArray(digests) &&
        digests.includes(scanner.image.replace(/:[^/:]+(?=@)/, "")),
      "Pinned scanner image is not present locally",
    );
  }
  const archive = await approvedInput(archiveInput);
  assert.equal((await lstat(archive)).isFile(), true);
  assert.ok((await lstat(archive)).size < 2 * 1024 ** 3);
  const databaseDirectory = await approvedInput(resolve(cacheInput, "db"));
  const metadataPath = await approvedInput(
    resolve(databaseDirectory, "metadata.json"),
  );
  const databasePath = await approvedInput(
    resolve(databaseDirectory, "trivy.db"),
  );
  assert.equal((await lstat(databasePath)).isFile(), true);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  validateDatabaseMetadata(metadata);
  const oci = inspectOciArchive(archive, expectedRevision);
  for (const layer of oci.layers) await verifyLayer(archive, layer);
  const initialArchiveSha256 = await sha256File(archive);
  const initialDatabaseSha256 = await sha256File(databasePath);
  const initialMetadataSha256 = await sha256File(metadataPath);
  const output = await mkdtemp(resolve(root, "tmp/artifact-scan-"));
  // Trivy accepts OCI layouts, while Syft also accepts OCI archives. Materialize
  // only previously validated content-addressed blobs, never arbitrary tar paths.
  const layout = resolve(output, "layout");
  await mkdir(resolve(layout, "blobs/sha256"), { recursive: true });
  for (const entry of [
    "oci-layout",
    "index.json",
    ...oci.blobs.map((blob) => `blobs/sha256/${blob.digest.slice(7)}`),
  ]) {
    assert.equal(
      await execute(
        "tar",
        ["-xOf", archive, "--", entry],
        60000,
        resolve(layout, entry),
      ),
      0,
    );
  }
  const args = isolationArgs(archive, databaseDirectory);
  const syftCode = await runScanner(
    args,
    [
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
    output,
    "sbom.spdx.json",
  );
  assert.equal(syftCode, 0, "SBOM generation failed");
  const sbom = JSON.parse(
    await readFile(resolve(output, "sbom.spdx.json"), "utf8"),
  );
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.ok(
    sbom.creationInfo.creators.includes(`Tool: syft-${pins.syft.version}`),
  );
  assert.ok(Array.isArray(sbom.packages) && sbom.packages.length > 0);
  const freshness = validateDatabaseMetadata(metadata, Date.now());
  const scanStartedAt = new Date().toISOString();
  const trivyCode = await runScanner(
    isolationArgs(layout, databaseDirectory, true),
    [
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
    output,
    "trivy.json",
  );
  assert.equal(trivyCode, 0, "Artifact scanner execution failed");
  const report = JSON.parse(
    await readFile(resolve(output, "trivy.json"), "utf8"),
  );
  const findings = validateScanReport(report, oci.manifests[0]);
  assert.equal(
    await sha256File(archive),
    initialArchiveSha256,
    "Artifact changed while being scanned",
  );
  assert.equal(
    await sha256File(databasePath),
    initialDatabaseSha256,
    "Vulnerability DB changed while being scanned",
  );
  assert.equal(
    await sha256File(metadataPath),
    initialMetadataSha256,
    "DB metadata changed while being scanned",
  );
  const evidence = {
    version: 1,
    sourceRevision: expectedRevision,
    archiveSha256: initialArchiveSha256,
    ...oci,
    database: {
      ...freshness,
      sha256: initialDatabaseSha256,
      metadataSha256: initialMetadataSha256,
    },
    scanners: pins,
    scanStartedAt,
    completedAt: new Date().toISOString(),
    sbomSha256: await sha256File(resolve(output, "sbom.spdx.json")),
    reportSha256: await sha256File(resolve(output, "trivy.json")),
    vulnerabilityCount: findings.length,
    artifactGatePassed: findings.length === 0,
    promotionApproved: false,
  };
  await writeFile(
    resolve(output, "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      output,
      artifactGatePassed: evidence.artifactGatePassed,
      vulnerabilityCount: findings.length,
      promotionApproved: false,
    }),
  );
  return findings.length > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv.length,
    5,
    "Usage: node scripts/scan-oci-artifact.mjs OWNED_OCI_ARCHIVE OWNED_TRIVY_CACHE FULL_SOURCE_COMMIT",
  );
  process.exitCode = await scanArtifact(
    process.argv[2],
    process.argv[3],
    process.argv[4],
  );
}
