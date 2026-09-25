/** Provider-neutral cited research and editable text suggestion boundary. */
export const RESEARCH_CONTRACT_VERSION = "editorial-research-v1" as const;
export const LOCAL_RESEARCH_ADAPTER_VERSION =
  "local-manual-research-v1" as const;
export const RESEARCH_FRESHNESS_POLICY_VERSION =
  "research-freshness-24h-v1" as const;
export const LOCAL_RESEARCH_COST_BASIS_VERSION =
  "local-provider-cost-zero-v1" as const;
export const PUBLIC_CITATION_TEXT_POLICY_VERSION =
  "public-citation-text-v1" as const;
export const PUBLIC_CITATION_TITLE_MAX_LENGTH = 500;
export const PUBLIC_CITATION_PUBLISHER_MAX_LENGTH = 300;
export const PUBLIC_CITATION_URL_MAX_LENGTH = 2_048;
export const PUBLIC_APPROVAL_CITATION_MAX_COUNT = 20;
export const PUBLIC_COMPONENT_INCOMPLETE_REASON_MAX_COUNT = 16;
export const PUBLIC_CITATION_URL_POLICY_VERSION =
  "public-citation-url-v1" as const;

export type PublicApprovalCitation = Readonly<{
  id: string;
  url: string;
  title: string;
  publisher: string;
  publishedAt: string | null;
  accessedAt: string;
}>;
export type PublicResearchFreshness = Readonly<{
  searchedAt: string;
  freshUntil: string;
  freshness: "CURRENT" | "EXPIRED";
}>;

export const PUBLIC_COMPONENT_INCOMPLETE_REASONS = [
  "COMPONENT_PROVENANCE_MISSING",
  "METADATA_LINEAGE_INVALID",
  "CITATIONS_INVALID",
  "CITATION_LINEAGE_INVALID",
  "TRANSCRIPT_LINEAGE_INVALID",
  "RESEARCH_EXPIRED",
  "THUMBNAIL_LINEAGE_INVALID",
  "DIRECT_COST_INVALID",
  "SNAPSHOT_INVALID",
] as const;

const PUBLIC_CITATION_KEYS = [
  "accessedAt",
  "id",
  "publishedAt",
  "publisher",
  "title",
  "url",
] as const;
const SENSITIVE_QUERY_NAMES = new Set([
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
  if (!value || value.length > PUBLIC_CITATION_URL_MAX_LENGTH) return null;
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
    !publicCitationHostname(url.hostname)
  )
    return null;
  const names = [...url.searchParams.keys()].map((name) => name.toLowerCase());
  const signed = names.some(
    (name) =>
      name.startsWith("x-amz-") ||
      name.startsWith("x-goog-") ||
      SENSITIVE_QUERY_NAMES.has(name),
  );
  if (signed || (names.includes("expires") && signed)) return null;
  url.searchParams.sort();
  return url.toString();
}

export function projectPublicApprovalCitations(
  value: unknown,
): PublicApprovalCitation[] | null {
  if (
    !Array.isArray(value) ||
    value.length > PUBLIC_APPROVAL_CITATION_MAX_COUNT
  )
    return null;
  const ids = new Set<string>();
  const projected: PublicApprovalCitation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    if (
      keys.length !== PUBLIC_CITATION_KEYS.length ||
      keys.some((key, index) => key !== PUBLIC_CITATION_KEYS[index])
    )
      return null;
    if (
      typeof row.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(row.id) ||
      ids.has(row.id) ||
      typeof row.url !== "string" ||
      normalizePublicCitationUrl(row.url) !== row.url ||
      !validPublicCitationText(row)
    )
      return null;
    const accessedAt = canonicalIsoDate(row.accessedAt);
    const publishedAt =
      row.publishedAt === null ? null : canonicalIsoDate(row.publishedAt);
    if (!accessedAt || (row.publishedAt !== null && !publishedAt)) return null;
    ids.add(row.id);
    projected.push({
      id: row.id,
      url: row.url,
      title: row.title as string,
      publisher: row.publisher as string,
      publishedAt,
      accessedAt,
    });
  }
  return projected;
}

export function projectPublicResearchFreshness(
  value: unknown,
): PublicResearchFreshness | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "freshUntil" ||
    keys[1] !== "freshness" ||
    keys[2] !== "searchedAt"
  )
    return null;
  const searchedAt = canonicalIsoDate(row.searchedAt);
  const freshUntil = canonicalIsoDate(row.freshUntil);
  if (
    !searchedAt ||
    !freshUntil ||
    (row.freshness !== "CURRENT" && row.freshness !== "EXPIRED")
  )
    return null;
  return { searchedAt, freshUntil, freshness: row.freshness };
}

export function projectPublicComponentIncompleteReasons(
  value: unknown,
): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > PUBLIC_COMPONENT_INCOMPLETE_REASON_MAX_COUNT ||
    value.some(
      (reason) =>
        typeof reason !== "string" ||
        !(PUBLIC_COMPONENT_INCOMPLETE_REASONS as readonly string[]).includes(
          reason,
        ),
    )
  )
    return null;
  const unique = [...new Set(value as string[])];
  return unique.length === value.length ? unique : null;
}

function canonicalIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? value
    : null;
}

function publicCitationHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (
    !normalized.includes(".") ||
    normalized.includes(":") ||
    normalized === "localhost" ||
    [".localhost", ".local", ".internal", ".home", ".lan"].some((suffix) =>
      normalized.endsWith(suffix),
    )
  )
    return false;
  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part)))
    return true;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

export function validPublicCitationText(value: {
  title?: unknown;
  publisher?: unknown;
}): boolean {
  return (
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    value.title.length <= PUBLIC_CITATION_TITLE_MAX_LENGTH &&
    typeof value.publisher === "string" &&
    value.publisher.trim().length > 0 &&
    value.publisher.length <= PUBLIC_CITATION_PUBLISHER_MAX_LENGTH
  );
}

export type ResearchCitation = Readonly<{
  id: string;
  url: string;
  title: string;
  publisher: string;
  publishedAt?: string | null;
  accessedAt: string;
  excerpt: string;
  checksum: string;
}>;

export type ResearchSnapshot = Readonly<{
  contractVersion: typeof RESEARCH_CONTRACT_VERSION;
  adapterVersion: string;
  query: string;
  citations: readonly ResearchCitation[];
  freshness: "CURRENT" | "STALE";
}>;

export type TextSuggestion = Readonly<{
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  basisVersion: string;
  citationIds: readonly string[];
  claims: readonly Readonly<{ text: string; citationIds: readonly string[] }>[];
}>;

export type ResearchSuggestionState =
  "QUEUED" | "PROCESSING" | "READY" | "FAILED_FINAL";

export type ResearchSuggestionView = Readonly<{
  id: string;
  transcriptIntentId: string;
  state: ResearchSuggestionState;
  snapshot: ResearchSnapshot &
    Readonly<{
      searchedAt: string;
      freshUntil: string;
      freshnessPolicyVersion: string;
    }>;
  suggestion: TextSuggestion | null;
  cost: Readonly<{
    directCostMicrousd: string;
    basisVersion: string;
  }> | null;
  failure: Readonly<{ code: string; message: string }> | null;
}>;

export function validateResearchSnapshot(snapshot: ResearchSnapshot): void {
  if (snapshot.contractVersion !== RESEARCH_CONTRACT_VERSION)
    throw new Error("RESEARCH_CONTRACT_INVALID");
  if (!snapshot.query.trim() || snapshot.query.length > 4_000)
    throw new Error("RESEARCH_QUERY_INVALID");
  if (snapshot.citations.length > 100)
    throw new Error("RESEARCH_CITATIONS_INVALID");
  for (const citation of snapshot.citations) {
    let url: URL;
    try {
      url = new URL(citation.url);
    } catch {
      throw new Error("RESEARCH_CITATION_INVALID");
    }
    if (
      url.protocol !== "https:" ||
      !citation.id ||
      !validPublicCitationText(citation) ||
      !citation.accessedAt ||
      !citation.excerpt.trim() ||
      !/^[a-f0-9]{64}$/.test(citation.checksum)
    )
      throw new Error("RESEARCH_CITATION_INVALID");
  }
}
