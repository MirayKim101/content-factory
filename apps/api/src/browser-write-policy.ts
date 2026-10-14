import type { IncomingMessage } from "node:http";

export const NATIVE_CLIENT_HEADER = "x-content-factory-client";
export const NATIVE_CLIENT_VALUE = "native-v1";

function canonicalOrigin(value: string): string | null {
  if (!/^https?:\/\/[^/?#\\\s%@]+$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hostname.includes("*")) return null;
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

export function browserWriteOrigins(
  value: string | undefined,
): ReadonlySet<string> {
  if (value === undefined || value.trim() === "") return new Set();
  const entries = value.split(",");
  if (value.length > 4096 || entries.length > 32) {
    throw new Error("CONFIG_API_BROWSER_ORIGINS_INVALID");
  }
  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = canonicalOrigin(entry.trim());
    if (origin === null || origins.has(origin)) {
      throw new Error("CONFIG_API_BROWSER_ORIGINS_INVALID");
    }
    origins.add(origin);
  }
  return origins;
}

function values(request: IncomingMessage, name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      found.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return found;
}

export function browserWriteAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")) return true;
  const origins = values(request, "origin");
  const sites = values(request, "sec-fetch-site");
  if (
    sites.length > 1 ||
    (sites.length === 1 && !["same-origin", "same-site"].includes(sites[0]!))
  ) {
    return false;
  }
  if (origins.length > 0) {
    if (origins.length !== 1) return false;
    const origin = canonicalOrigin(origins[0]!);
    return origin !== null && allowedOrigins.has(origin);
  }
  // Node fetch supplies Sec-Fetch-Mode:cors even without browser provenance.
  // Permit only that exact transport field; never Site/Dest/User/unknown fields.
  const modes = values(request, "sec-fetch-mode");
  if (
    values(request, "referer").length > 0 ||
    modes.length > 1 ||
    (modes.length === 1 && modes[0] !== "cors") ||
    request.rawHeaders.some(
      (name, index) =>
        index % 2 === 0 &&
        name.toLowerCase().startsWith("sec-fetch-") &&
        name.toLowerCase() !== "sec-fetch-mode",
    )
  ) {
    return false;
  }
  const native = values(request, NATIVE_CLIENT_HEADER);
  return native.length === 1 && native[0] === NATIVE_CLIENT_VALUE;
}
