import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvedPath,
  contractPaths,
  parseTree,
  exportContext,
} from "./export-worker-build-context.mjs";

test("context selects worker source and exact contract modules", () => {
  const contracts = contractPaths({
    exports: { ".": "./src/index.ts" },
    imports: { "#frame-policy": "./src/frame-policy.ts" },
  });
  assert.equal(approvedPath("apps/worker/src/main.ts", contracts), true);
  assert.equal(
    approvedPath("packages/contracts/src/frame-policy.ts", contracts),
    true,
  );
  for (const path of [
    "apps/worker/test/a.ts",
    "apps/worker/src/a.spec.ts",
    "apps/worker/src/a.test.ts",
    "apps/worker/src/__tests__/a.ts",
    "apps/worker/src/__fixtures__/a.ts",
    "packages/contracts/src/extra.ts",
    "apps/worker/src/.env",
    "apps/worker/src/Seanova/a.ts",
    "apps/worker/src/sEaNoVa-NeW/a.ts",
    "apps/worker/src/dockerServer/a.ts",
    "apps/worker/src/../a.ts",
    "package-lock.json",
  ]) {
    assert.equal(approvedPath(path, contracts), false, path);
  }
});

test("symlink/submodule and malformed tree entries fail closed before blob materialization", () => {
  const blob = "a".repeat(40);
  assert.deepEqual(
    parseTree(Buffer.from(`100644 blob ${blob}\tapps/worker/package.json\0`)),
    [{ mode: "100644", blob, path: "apps/worker/package.json" }],
  );
  for (const entry of [
    `120000 blob ${blob}\tapps/worker/src/link.ts\0`,
    `160000 commit ${blob}\tapps/worker/src/repo\0`,
    "broken\0",
  ]) {
    assert.throws(() => parseTree(Buffer.from(entry)));
  }
});

test("contracts cannot widen their context to arbitrary files", () => {
  assert.throws(() =>
    contractPaths({
      exports: { ".": "./src/index.ts" },
      imports: { "#evil": "../../.env" },
    }),
  );
  assert.throws(() =>
    contractPaths({
      exports: { ".": "./src/index.ts" },
      imports: { "#a": "./src/a.ts", "#b": "./src/a.ts" },
    }),
  );
});

test("mutable refs and option injection are refused without accessing a revision", async () => {
  for (const revision of ["HEAD", "main", "--all", "../bad", "a".repeat(39)]) {
    await assert.rejects(exportContext(revision), /full commit SHA/);
  }
});
