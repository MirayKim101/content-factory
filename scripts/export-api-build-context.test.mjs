import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvedPath,
  contractPaths,
  parseTree,
  exportContext,
} from "./export-api-build-context.mjs";

test("context selects product source, canonical migrations and exact contract modules", () => {
  const contracts = contractPaths({
    exports: { ".": "./src/index.ts" },
    imports: { "#frame-policy": "./src/frame-policy.ts" },
  });
  assert.equal(
    approvedPath(
      "apps/api/src/editorial-content/application/apply-ai-thumbnail.ts",
      contracts,
    ),
    true,
  );
  assert.equal(
    approvedPath(
      "apps/api/prisma/migrations/20260101000000_initial/migration.sql",
      contracts,
    ),
    true,
  );
  assert.equal(
    approvedPath("packages/contracts/src/frame-policy.ts", contracts),
    true,
  );
  for (const path of [
    "apps/api/test/a.ts",
    "apps/api/src/a.spec.ts",
    "apps/api/src/a.test.ts",
    "apps/api/src/__tests__/a.ts",
    "apps/api/src/__fixtures__/a.ts",
    "packages/contracts/src/extra.ts",
    "apps/api/src/.env",
    "apps/api/src/.idea/a.ts",
    "apps/api/src/Seanova/a.ts",
    "apps/api/src/sEaNoVa-NeW/a.ts",
    "apps/api/src/dockerServer/a.ts",
    "apps/api/src/../a.ts",
    "package-lock.json",
  ]) {
    assert.equal(approvedPath(path, contracts), false, path);
  }
});

test("symlink/submodule and malformed tree entries fail closed before any blob materialization", () => {
  const blob = "a".repeat(40);
  assert.deepEqual(
    parseTree(Buffer.from(`100644 blob ${blob}\tapps/api/package.json\0`)),
    [{ mode: "100644", blob, path: "apps/api/package.json" }],
  );
  for (const entry of [
    `120000 blob ${blob}\tapps/api/src/link.ts\0`,
    `160000 commit ${blob}\tapps/api/src/repo\0`,
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
