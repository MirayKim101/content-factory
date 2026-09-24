import { isIP } from "node:net";

export const PUBLIC_CITATION_URL_POLICY_VERSION = "public-citation-url-v1";

const ALWAYS_SENSITIVE_QUERY_NAMES = new Set([
  "access_token",
  "apikey",
  "api_key",
  "awsaccesskeyid",
  "credential",
  "googleaccessid",
  "key",
  "signature",
  "sig",
  "subscription-key",
  "token",
]);
const AZURE_SAS_QUERY_NAMES = new Set([
  "se",
  "skoid",
  "sks",
  "skt",
  "sktid",
  "skv",
  "sp",
  "spr",
  "sr",
  "st",
  "sv",
]);

export function normalizePublicCitationUrl(value: string): string | null {
  if (!value || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !publicHostname(url.hostname)
  )
    return null;

  const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
  const cloudSignedContext = names.some(
    (name) =>
      name.startsWith("x-amz-") ||
      name.startsWith("x-goog-") ||
      ALWAYS_SENSITIVE_QUERY_NAMES.has(name) ||
      AZURE_SAS_QUERY_NAMES.has(name),
  );
  if (
    names.some(
      (name) =>
        name.startsWith("x-amz-") ||
        name.startsWith("x-goog-") ||
        ALWAYS_SENSITIVE_QUERY_NAMES.has(name) ||
        AZURE_SAS_QUERY_NAMES.has(name) ||
        (name === "expires" && cloudSignedContext),
    )
  )
    return null;

  url.searchParams.sort();
  return url.toString();
}

function publicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    !normalized.includes(".") ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".lan")
  )
    return false;
  const ipVersion = isIP(normalized.replace(/^\[|\]$/g, ""));
  if (ipVersion === 6) return false;
  if (ipVersion !== 4) return true;
  const [a, b] = normalized.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}
