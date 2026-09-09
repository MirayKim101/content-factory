import { createHash } from "node:crypto";

export const CREATOR_URL_POLICY_VERSION = "creator-official-url-v1";
export const AI_OPERATION_CONTRACT_VERSION = "ai-content-operation-v1";
export const CREATOR_RIGHTS_DECLARATION_VERSION = "creator-likeness-rights-v1";
export const MANUAL_PROVENANCE_VERSION = "manual-editorial-v1";
export const LEGACY_MANUAL_PROVENANCE_VERSION = "legacy-manual-editorial-v1";

export type AiCapability =
  | "RESEARCH"
  | "TEXT_GENERATION"
  | "TRANSCRIPT"
  | "NO_LIKENESS_IMAGE"
  | "REALISTIC_LIKENESS_IMAGE";

export type CreatorProfileEditableRevision = {
  canonicalDisplayName: string;
  officialUrl: string;
  primaryLanguage: string;
  topics: string[];
  editorialNotes: string;
  restrictions: string[];
};

export type SourceContextEditableRevision = {
  creatorProfileId: string;
  creatorProfileRevision: number;
  sourceTitle: string;
  gameOrTopic: string;
  audience: string;
  editorialGoal: string;
  language: string;
  defaultCta: string;
  restrictions: string[];
  operatorNotes: string;
};

export type CutPromptEditableRevision = {
  sourceContextId: string;
  sourceContextRevision: number;
  whatHappens: string;
  desiredAngle: string;
  tone: string;
  cta: string;
  restrictions: string[];
};

export class CreatorContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly safeDetails?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
  }
}

export function canonicalizeOfficialUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw invalidOfficialUrl();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === ""
  ) {
    throw invalidOfficialUrl();
  }
  if (parsed.port === "443") parsed.port = "";
  parsed.pathname = normalizeUrlPath(parsed.pathname);
  return parsed.toString();
}

export function normalizeOrderedStrings(
  values: readonly string[],
  field: string,
  maximumItems: number,
): string[] {
  if (values.length > maximumItems) {
    throw new CreatorContextError(
      "AI_CONTEXT_VALUE_INVALID",
      `${field} has too many values.`,
      422,
    );
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value.length === 0)) {
    throw new CreatorContextError(
      "AI_CONTEXT_VALUE_INVALID",
      `${field} contains an empty value.`,
      422,
    );
  }
  const keys = normalized.map((value) => value.toLocaleLowerCase("und"));
  if (new Set(keys).size !== keys.length) {
    throw new CreatorContextError(
      "AI_CONTEXT_VALUE_INVALID",
      `${field} contains a duplicate value.`,
      422,
    );
  }
  return normalized;
}

export function canonicalFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function contextPolicyFingerprint(value: unknown): string {
  return canonicalFingerprint({ version: "ai-context-policy-v1", value });
}

export function encodeScopedCursor(input: {
  scope: string;
  createdAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify([
      "ai-context-cursor-v1",
      input.scope,
      input.createdAt.toISOString(),
      input.id,
    ]),
  ).toString("base64url");
}

export function decodeScopedCursor(
  value: string | undefined,
  scope: string,
): { createdAt: Date; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    ) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== "ai-context-cursor-v1" ||
      parsed[1] !== scope ||
      typeof parsed[2] !== "string" ||
      typeof parsed[3] !== "string" ||
      !isUuidV4(parsed[3])
    ) {
      throw new Error("invalid cursor");
    }
    const createdAt = new Date(parsed[2]);
    if (!Number.isFinite(createdAt.getTime())) throw new Error("invalid date");
    return { createdAt, id: parsed[3] };
  } catch {
    throw new CreatorContextError(
      "AI_CONTEXT_CURSOR_INVALID",
      "The pagination cursor is invalid for this resource.",
      400,
    );
  }
}

export function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function invalidOfficialUrl(): CreatorContextError {
  return new CreatorContextError(
    "CREATOR_PROFILE_OFFICIAL_URL_INVALID",
    "Official URL must be HTTPS and must not contain credentials, query, or fragment.",
    422,
  );
}

function normalizeUrlPath(pathname: string): string {
  const normalizedPercent = pathname.replace(/%[0-9a-fA-F]{2}/g, (encoded) => {
    const byte = Number.parseInt(encoded.slice(1), 16);
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9._~-]/.test(character)
      ? character
      : `%${encoded.slice(1).toUpperCase()}`;
  });
  if (normalizedPercent === "/") return "/";
  return normalizedPercent.replace(/\/+$/, "");
}
