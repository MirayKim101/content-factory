import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";

const proof = JSON.parse(readFileSync("build-provenance.json", "utf8"));
assert.match(process.argv[2] ?? "", /^[a-f0-9]{40}$/);
assert.equal(proof.commit, process.argv[2]);
assert.match(proof.tree, /^[a-f0-9]{40}$/);
const directories = new Map([[".", new Set(["build-provenance.json"])]]);
const seen = new Set();
for (const file of proof.files) {
  assert.match(file.path, /^[a-zA-Z0-9_./-]+$/);
  assert.equal(seen.has(file.path), false);
  seen.add(file.path);
  const parts = file.path.split("/");
  assert.ok(
    parts.every(
      (part) =>
        part &&
        part !== "." &&
        part !== ".." &&
        !/^(se[aá]nova(?:-new)?|dockerserver)$/i.test(part),
    ),
  );
  let parent = ".";
  for (const part of parts) {
    if (!directories.has(parent)) directories.set(parent, new Set());
    directories.get(parent).add(part);
    parent = parent === "." ? part : `${parent}/${part}`;
  }
  assert.match(file.blob, /^[a-f0-9]{40}$/);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
}
for (const [directory, entries] of directories) {
  assert.equal(lstatSync(directory).isSymbolicLink(), false);
  assert.deepEqual(readdirSync(directory).sort(), [...entries].sort());
}
for (const file of proof.files) {
  assert.equal(lstatSync(file.path).isFile(), true);
  assert.equal(
    createHash("sha256").update(readFileSync(file.path)).digest("hex"),
    file.sha256,
  );
}
