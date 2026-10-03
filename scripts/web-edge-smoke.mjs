import assert from "node:assert/strict";

const staticAsset =
  /\.(?:avif|css|gif|ico|jpe?g|js|map|mjs|png|svg|webp|woff2?)$/i;

export function classifyEdgeRequest(requestTarget, fileExists) {
  const request = new URL(requestTarget, "http://edge.invalid");
  const path = request.pathname;
  if (path === "/healthz") return { kind: "liveness", status: 200 };
  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    return { kind: "api", upstreamPath: `${path}${request.search}` };
  }
  if (path.startsWith("/_nuxt/")) {
    return fileExists
      ? { kind: "static", cacheControl: "public, max-age=31536000, immutable" }
      : { kind: "missing-asset", status: 404 };
  }
  if (staticAsset.test(path)) {
    return fileExists
      ? { kind: "static" }
      : { kind: "missing-asset", status: 404 };
  }
  return { kind: "spa", cacheControl: "no-store", file: "/index.html" };
}

export function forwardedHeaders(headers) {
  assert.equal(Object.getPrototypeOf(headers), Object.prototype);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    assert.equal(typeof value, "string", `Header ${name} must be a string`);
    const normalized = name.toLowerCase();
    if (normalized === "forwarded" || normalized.startsWith("x-forwarded-")) {
      continue;
    }
    result[name] = value;
  }
  return result;
}
