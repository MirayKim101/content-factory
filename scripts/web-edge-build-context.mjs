import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exportContext } from "./export-web-build-context.mjs";

// Extend the existing reviewed static closure without changing its owner.
const revision = process.argv[2];
assert.match(revision ?? "", /^[a-f0-9]{40}$/);
const result = await exportContext(revision);
const proofPath = resolve(result.destination, "build-provenance.json");
const proof = JSON.parse(await readFile(proofPath, "utf8"));
for (const path of [
  "infrastructure/web-edge/Dockerfile",
  "infrastructure/web-edge/Caddyfile",
  "infrastructure/web-edge/verify-context.mjs",
]) {
  const tree = execFileSync("git", ["ls-tree", revision, "--", path], {
    encoding: "utf8",
  });
  const match = /^100644 blob ([a-f0-9]{40})\t(.+)\n$/.exec(tree);
  assert.ok(match, `Missing regular exact Git input: ${path}`);
  assert.equal(match[2], path);
  const content = execFileSync("git", ["cat-file", "blob", match[1]]);
  await mkdir(dirname(resolve(result.destination, path)), { recursive: true });
  await writeFile(resolve(result.destination, path), content, {
    flag: "wx",
    mode: 0o644,
  });
  proof.files.push({
    mode: "100644",
    blob: match[1],
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
proof.files.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify({ ...result, files: proof.files.length }));
