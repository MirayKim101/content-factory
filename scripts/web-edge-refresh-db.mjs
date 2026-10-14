// Connected preparation only. Offline scanners never update the database.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvedInput,
  captureOutput,
  sha256File,
} from "./scan-oci-artifact.mjs";
import { validateWebDatabaseMetadata } from "./web-edge-artifact-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(resolve(root, "tmp/web-edge-db-"));
console.log(JSON.stringify({ output }));
const get = async (url, headers = {}) => {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(1200000),
  });
  assert.equal(
    response.status,
    200,
    `Registry request failed: ${response.status}`,
  );
  return response;
};
const token = await (
  await get(
    "https://ghcr.io/token?service=ghcr.io&scope=repository:aquasecurity/trivy-db:pull",
  )
).json();
const headers = {
  Authorization: `Bearer ${token.token}`,
  Accept: "application/vnd.oci.image.manifest.v1+json",
};
const response = await get(
  "https://ghcr.io/v2/aquasecurity/trivy-db/manifests/2",
  headers,
);
const bytes = Buffer.from(await response.arrayBuffer());
const manifestDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
assert.equal(response.headers.get("docker-content-digest"), manifestDigest);
const manifest = JSON.parse(bytes);
assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.mediaType, "application/vnd.oci.image.manifest.v1+json");
assert.equal(manifest.layers.length, 1);
const layer = manifest.layers[0];
assert.equal(
  layer.mediaType,
  "application/vnd.aquasec.trivy.db.layer.v1.tar+gzip",
);
assert.match(layer.digest, /^sha256:[a-f0-9]{64}$/);
let archive;
if (process.argv[2]) {
  const input = resolve(process.argv[2]);
  assert.equal(
    /(?:^|\/)(?:seanova(?:-new)?|dockerserver)(?:\/|$)/i.test(
      input.normalize("NFD").replace(/\p{M}/gu, ""),
    ),
    false,
  );
  archive = await approvedInput(input);
  assert.equal((await stat(archive)).size, layer.size);
  assert.equal(`sha256:${await sha256File(archive)}`, layer.digest);
} else {
  const blob = await get(
    `https://ghcr.io/v2/aquasecurity/trivy-db/blobs/${layer.digest}`,
    headers,
  );
  archive = resolve(output, "db.tar.gz");
  const file = await open(archive, "wx", 0o600);
  try {
    await captureOutput(
      (async function* () {
        let downloaded = 0;
        let nextProgress = 16 * 1024 ** 2;
        for await (const chunk of blob.body) {
          downloaded += chunk.length;
          if (downloaded >= nextProgress) {
            console.log(JSON.stringify({ downloaded, expected: layer.size }));
            nextProgress += 16 * 1024 ** 2;
          }
          yield Buffer.from(chunk);
        }
      })(),
      file,
      layer,
    );
  } finally {
    await file.close();
  }
}
await writeFile(
  resolve(output, "registry-proof.json"),
  `${JSON.stringify({ manifestDigest, manifest }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .trim()
  .split("\n")
  .sort();
assert.deepEqual(listing, ["metadata.json", "trivy.db"]);
const database = resolve(output, "db");
await mkdir(database, { mode: 0o700 });
for (const name of listing) {
  const target = await open(resolve(database, name), "wx", 0o600);
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn("tar", ["-xzOf", archive, "--", name], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise((r, j) => {
      child.on("error", j);
      child.on("exit", r);
    });
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      assert.ok(
        size <= 2 * 1024 ** 3,
        "Uncompressed database exceeds 2 GiB bound",
      );
      let offset = 0;
      while (offset < chunk.length) {
        const result = await target.write(chunk, offset, chunk.length - offset);
        assert.ok(result.bytesWritten > 0);
        offset += result.bytesWritten;
      }
    }
    assert.equal(await exited, 0);
  } finally {
    await target.close();
  }
}
const metadata = JSON.parse(
  await readFile(resolve(database, "metadata.json"), "utf8"),
);
const freshness = validateWebDatabaseMetadata(metadata);
const proof = {
  repository: "ghcr.io/aquasecurity/trivy-db:2",
  manifestDigest,
  layer,
  freshness,
  metadataSha256: await sha256File(resolve(database, "metadata.json")),
  databaseSha256: await sha256File(resolve(database, "trivy.db")),
  completedAt: new Date().toISOString(),
};
await writeFile(
  resolve(output, "refresh-proof.json"),
  `${JSON.stringify(proof, null, 2)}\n`,
);
console.log(JSON.stringify({ output, ...proof }));
