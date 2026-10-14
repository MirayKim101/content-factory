import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(resolve(root, "tmp/web-edge-registry-"));
const response = await fetch(
  "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/caddy:pull",
  { signal: AbortSignal.timeout(30000) },
);
assert.equal(response.status, 200);
const token = await response.json();
const headers = {
  Authorization: `Bearer ${token.token}`,
  Accept:
    "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
};
const evidence = {
  checkedAt: new Date().toISOString(),
  image: "caddy:2.11.7-alpine",
  requests: [],
  promotionApproved: false,
};
async function verified(path, digest, checkHeader = true) {
  const url = `https://registry-1.docker.io/v2/library/caddy/${path}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  assert.equal(r.status, 200);
  const bytes = Buffer.from(await r.arrayBuffer());
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(actual, digest);
  if (checkHeader) assert.equal(r.headers.get("docker-content-digest"), digest);
  const value = JSON.parse(bytes);
  evidence.requests.push({ url, status: r.status, digest: actual, value });
  return value;
}
const index = await verified(
  "manifests/2.11.7-alpine",
  "sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f",
);
const leaf = index.manifests.filter(
  (m) => m.platform.os === "linux" && m.platform.architecture === "amd64",
);
assert.equal(leaf.length, 1);
assert.equal(
  leaf[0].digest,
  "sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229",
);
const manifest = await verified(`manifests/${leaf[0].digest}`, leaf[0].digest);
assert.equal(
  manifest.config.digest,
  "sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77",
);
const config = await verified(
  `blobs/${manifest.config.digest}`,
  manifest.config.digest,
  false,
);
assert.equal(config.os, "linux");
assert.equal(config.architecture, "amd64");
assert.ok(config.config.Env.includes("CADDY_VERSION=v2.11.7"));
await writeFile(
  resolve(output, "registry-proof.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({
    output,
    index: evidence.requests[0].digest,
    leaf: leaf[0].digest,
    config: manifest.config.digest,
  }),
);
