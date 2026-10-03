import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const forbidden = /(?:^|\/)(?:seanova(?:-new)?|dockerserver)(?:\/|$)/i;
const fixed = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "apps/api/tsconfig.build.json",
  "apps/api/prisma/schema.prisma",
  "apps/api/prisma/migrations/migration_lock.toml",
  "packages/contracts/package.json",
  "packages/contracts/tsconfig.json",
  "packages/api-migrate/package.json",
  "packages/api-migrate/prisma.config.mjs",
  "infrastructure/api/Dockerfile",
]);

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function approvedPath(path, contracts) {
  if (
    forbidden.test(path) ||
    path.split("/").some((part) => part === ".." || part.startsWith(".")) ||
    path.includes("\\")
  ) {
    return false;
  }
  return (
    fixed.has(path) ||
    contracts.has(path) ||
    (/^apps\/api\/src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.ts$/.test(path) &&
      !/\.(?:spec|test)\.ts$/.test(path) &&
      !/(?:^|\/)(?:__tests__|__fixtures__)(?:\/|$)/.test(path)) ||
    /^apps\/api\/prisma\/migrations\/[0-9]+_[a-zA-Z0-9_-]+\/migration\.sql$/.test(
      path,
    )
  );
}

export function contractPaths(manifest) {
  assert.equal(manifest.exports["."], "./src/index.ts");
  const paths = ["packages/contracts/src/index.ts"];
  for (const target of Object.values(manifest.imports)) {
    assert.match(target, /^\.\/src\/[a-z0-9-]+\.ts$/);
    paths.push(`packages/contracts/${target.slice(2)}`);
  }
  assert.equal(new Set(paths).size, paths.length);
  return new Set(paths);
}

export function parseTree(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      assert.ok(
        match,
        "Only regular committed files are permitted: no symlinks/submodules",
      );
      return { mode: match[1], blob: match[2], path: match[3] };
    });
}

export async function exportContext(revision) {
  assert.match(revision, /^[a-f0-9]{40}$/, "Supply an exact full commit SHA");
  assert.equal(
    git("rev-parse", `${revision}^{commit}`).toString().trim(),
    revision,
  );
  const contracts = contractPaths(
    JSON.parse(
      git("show", `${revision}:packages/contracts/package.json`).toString(),
    ),
  );
  const entries = parseTree(
    git(
      "ls-tree",
      "-rz",
      revision,
      "--",
      ...fixed,
      "apps/api/src",
      "apps/api/prisma/migrations",
      ...contracts,
    ),
  );
  const selected = entries.filter((entry) =>
    approvedPath(entry.path, contracts),
  );
  const present = new Set(selected.map((entry) => entry.path));
  for (const required of [...fixed, ...contracts]) {
    assert.ok(
      present.has(required),
      `Missing committed build input: ${required}`,
    );
  }
  assert.ok(selected.some((entry) => entry.path.endsWith("/migration.sql")));
  const temporary = resolve(root, "tmp");
  await mkdir(temporary, { recursive: true });
  assert.equal(
    (await lstat(temporary)).isSymbolicLink(),
    false,
    "Temporary root must not be a symlink",
  );
  const destination = await mkdtemp(resolve(temporary, "api-context-"));
  const inventory = [];
  for (const entry of selected.sort((a, b) => a.path.localeCompare(b.path))) {
    const content = git("cat-file", "blob", entry.blob);
    const target = resolve(destination, entry.path);
    assert.ok(target.startsWith(`${destination}/`));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx", mode: 0o644 });
    inventory.push({
      ...entry,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  const provenance = {
    version: 1,
    commit: revision,
    tree: git("rev-parse", `${revision}^{tree}`).toString().trim(),
    files: inventory,
    promotion: "blocked-until-all-release-gates-pass",
  };
  await writeFile(
    resolve(destination, "build-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { flag: "wx" },
  );
  return {
    destination,
    commit: revision,
    tree: provenance.tree,
    files: inventory.length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv.length,
    3,
    "Usage: node scripts/export-api-build-context.mjs FULL_COMMIT_SHA",
  );
  console.log(JSON.stringify(await exportContext(process.argv[2])));
}
