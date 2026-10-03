import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvedPath,
  contractPaths,
  parseTree,
} from "./export-web-build-context.mjs";

test("web context accepts only static SPA source and exact contract closure", () => {
  const contracts = new Set(["packages/contracts/src/index.ts"]);
  assert.equal(approvedPath("apps/web/app/pages/index.vue", contracts), true);
  assert.equal(
    approvedPath("packages/contracts/src/index.ts", contracts),
    true,
  );
  for (const path of [
    "apps/web/test/source-upload.spec.ts",
    "apps/api/src/main.ts",
    ".env",
    ".idea/workspace.xml",
    "DockerServer/secret",
    "Seanova/secret",
  ]) {
    assert.equal(approvedPath(path, contracts), false, path);
  }
});

test("contract closure rejects unreviewed package import targets", () => {
  assert.deepEqual(
    [
      ...contractPaths({
        exports: { ".": "./src/index.ts" },
        imports: { "#vertical": "./src/vertical.ts" },
      }),
    ],
    ["packages/contracts/src/index.ts", "packages/contracts/src/vertical.ts"],
  );
  assert.throws(() =>
    contractPaths({
      exports: { ".": "./dist/index.js" },
      imports: {},
    }),
  );
});

test("tree parsing refuses symlinks and non-blob inputs", () => {
  assert.deepEqual(
    parseTree(
      Buffer.from(
        "100644 blob abcdefabcdefabcdefabcdefabcdefabcdefabcd\tapps/web/app/app.vue\0",
      ),
    ),
    [
      {
        mode: "100644",
        blob: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        path: "apps/web/app/app.vue",
      },
    ],
  );
  assert.throws(() => parseTree(Buffer.from("120000 blob deadbeef\tlink\0")));
});

test("Caddyfile fixes HTTP-only edge routing, streaming proxying, and SPA cache boundaries", async () => {
  const path = fileURLToPath(
    new URL("../infrastructure/web/Caddyfile", import.meta.url),
  );
  const caddyfile = await readFile(path, "utf8");
  for (const expected of [
    "admin off",
    "auto_https off",
    "http://:8080",
    "reverse_proxy api:3001",
    "header_up -Forwarded",
    "header_up -X-Forwarded-*",
    "flush_interval -1",
    "compression off",
    "handle /_nuxt/*",
    "(?i)\\.(?:avif|css|gif|ico|jpe?g|js|map|mjs|png|svg|webp|woff2?)$",
    'Cache-Control "public, max-age=31536000, immutable"',
    'Cache-Control "no-store"',
    "try_files {path} /index.html",
  ]) {
    assert.match(
      caddyfile,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.doesNotMatch(
    caddyfile,
    /^\s*(?:handle_path|request_buffers|response_buffers)\b/m,
  );
});
