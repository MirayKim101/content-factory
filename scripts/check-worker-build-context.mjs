import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "packages/contracts/package.json"), "utf8"),
);
const expected = [
  "packages/contracts/src/index.ts",
  ...Object.values(manifest.imports).map((target) => {
    assert.match(target, /^\.\/src\/[a-z0-9-]+\.ts$/);
    return `packages/contracts/${target.slice(2)}`;
  }),
].sort();
assert.equal(new Set(expected).size, expected.length);
for (const path of expected) {
  assert.equal((await lstat(resolve(root, path))).isFile(), true, path);
}

const policies = [".dockerignore", "apps/worker/Dockerfile.dockerignore"];
let previous;
for (const policy of policies) {
  const lines = (await readFile(resolve(root, policy), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (previous) assert.deepEqual(lines, previous, "Worker policies must agree");
  previous = lines;
  const expectedIncludes = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/",
    "apps/worker/",
    "apps/worker/package.json",
    "apps/worker/tsconfig.json",
    "apps/worker/tsconfig.build.json",
    "apps/worker/src/",
    "apps/worker/src/**",
    "packages/",
    "packages/contracts/",
    "packages/contracts/package.json",
    "packages/contracts/tsconfig.json",
    "packages/contracts/src/",
    ...expected,
    "infrastructure/",
    "infrastructure/worker/",
    "infrastructure/worker/entrypoint",
    "infrastructure/worker/healthcheck.mjs",
  ].sort();
  assert.deepEqual(
    lines
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1))
      .sort(),
    expectedIncludes,
    `${policy}: no other application, data or credentials may be included`,
  );
  const allowed = lines
    .filter((line) => line.startsWith("!packages/contracts/src/"))
    .filter((line) => line !== "!packages/contracts/src/")
    .map((line) => line.slice(1))
    .sort();
  assert.deepEqual(allowed, expected, `${policy}: exact runtime contract set`);

  // Reopening a parent directory also reopens descendants. Re-deny them
  // before including specific children; a plain '*' is not a closed context.
  for (const directory of [
    "apps/",
    "apps/worker/",
    "packages/",
    "packages/contracts/",
    "packages/contracts/src/",
    "infrastructure/",
    "infrastructure/worker/",
  ]) {
    const index = lines.indexOf(`!${directory}`);
    assert.ok(index >= 0, `${policy}: missing parent ${directory}`);
    assert.equal(lines[index + 1], `${directory}**`, policy);
  }
  assert.equal(lines[0], "*", policy);
  console.log(`PASS ${policy}: ${expected.length} exact contract modules`);
}
