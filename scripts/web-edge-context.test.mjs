import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(
  new URL("../infrastructure/web-edge/verify-context.mjs", import.meta.url),
);
test("exact context verifier rejects revision drift, injected files, changed bytes, and symlink parents", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "cf-web-edge-context-"));
  const revision = "a".repeat(40);
  const content = "closed-source";
  const proof = {
    commit: revision,
    tree: "b".repeat(40),
    files: [
      {
        path: "nested/input.txt",
        blob: "c".repeat(40),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  };
  const run = (ref = revision) =>
    execFileSync(process.execPath, [verifier, ref], {
      cwd: directory,
      stdio: "pipe",
    });
  try {
    await mkdir(resolve(directory, "nested"));
    await writeFile(resolve(directory, "nested/input.txt"), content);
    await writeFile(
      resolve(directory, "build-provenance.json"),
      JSON.stringify(proof),
    );
    run();
    assert.throws(() => run("d".repeat(40)));
    await writeFile(resolve(directory, "unexpected.txt"), "injected");
    assert.throws(() => run());
    await rm(resolve(directory, "unexpected.txt"));
    await writeFile(resolve(directory, "nested/input.txt"), "changed");
    assert.throws(() => run());
    await rm(resolve(directory, "nested"), { recursive: true });
    await mkdir(resolve(directory, "safe-fixture"));
    await writeFile(resolve(directory, "safe-fixture/input.txt"), content);
    await symlink("safe-fixture", resolve(directory, "nested"));
    assert.throws(() => run());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
