import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import { classifyEdgeRequest, forwardedHeaders } from "./web-edge-smoke.mjs";

test("SPA framing policy is scoped to HTML fallback without changing API or popup isolation", async () => {
  const config = await readFile(
    new URL("../infrastructure/web-edge/Caddyfile", import.meta.url),
    "utf8",
  );
  const fallback = config.slice(config.lastIndexOf("\thandle {"));
  assert.match(fallback, /Content-Security-Policy "frame-ancestors 'none'"/);
  assert.match(fallback, /X-Frame-Options DENY/);
  assert.match(fallback, /Cache-Control "no-store"/);
  assert.equal((config.match(/Content-Security-Policy/g) ?? []).length, 1);
  assert.equal((config.match(/X-Frame-Options/g) ?? []).length, 1);
  assert.doesNotMatch(
    config,
    /Cross-Origin-Opener-Policy|script-src|default-src/,
  );
  assert.match(config, /reverse_proxy api:3001/);
});

test("API fixtures preserve path/query and media/idempotency headers while dropping spoofed forwarding", () => {
  assert.deepEqual(
    classifyEdgeRequest("/api/v1/projects?limit=20&cursor=next", false),
    {
      kind: "api",
      upstreamPath: "/api/v1/projects?limit=20&cursor=next",
    },
  );
  const headers = forwardedHeaders({
    "Content-Type": "application/octet-stream",
    "Content-Range": "bytes 0-1023/4096",
    Range: "bytes=1024-2047",
    "Idempotency-Key": "fixture-replay-key",
    "X-Request-Id": "fixture-request-id",
    Forwarded: "for=attacker.example",
    "X-Forwarded-For": "203.0.113.66",
    "X-Forwarded-Host": "attacker.example",
    "X-Forwarded-Proto": "https",
  });
  assert.deepEqual(headers, {
    "Content-Type": "application/octet-stream",
    "Content-Range": "bytes 0-1023/4096",
    Range: "bytes=1024-2047",
    "Idempotency-Key": "fixture-replay-key",
    "X-Request-Id": "fixture-request-id",
  });
});

test("static, missing-asset, deep-link, and liveness fixtures remain distinct", () => {
  assert.deepEqual(classifyEdgeRequest("/healthz", false), {
    kind: "liveness",
    status: 200,
  });
  assert.deepEqual(classifyEdgeRequest("/_nuxt/app.hash.js", true), {
    kind: "static",
    cacheControl: "public, max-age=31536000, immutable",
  });
  assert.deepEqual(classifyEdgeRequest("/_nuxt/missing.hash.js", false), {
    kind: "missing-asset",
    status: 404,
  });
  assert.deepEqual(classifyEdgeRequest("/favicon.ico", false), {
    kind: "missing-asset",
    status: 404,
  });
  assert.deepEqual(classifyEdgeRequest("/assets/app.JS", false), {
    kind: "missing-asset",
    status: 404,
  });
  assert.deepEqual(classifyEdgeRequest("/horizontal", false), {
    kind: "spa",
    cacheControl: "no-store",
    file: "/index.html",
  });
});
