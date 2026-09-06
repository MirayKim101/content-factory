import { describe, expect, it } from "vitest";

import {
  CreatorContextError,
  canonicalizeOfficialUrl,
  decodeScopedCursor,
  encodeScopedCursor,
  normalizeOrderedStrings,
} from "../src/ai-content/domain/creator-context.js";

describe("creator official URL identity", () => {
  it.each([
    [
      "HTTPS://Example.COM:443/a/../Profile/%7e/",
      "https://example.com/Profile/~",
    ],
    [
      "https://пример.рф/Стример",
      "https://xn--e1afmkfd.xn--p1ai/%D0%A1%D1%82%D1%80%D0%B8%D0%BC%D0%B5%D1%80",
    ],
    ["https://example.com/%41/%2f", "https://example.com/A/%2F"],
    ["https://example.com/", "https://example.com/"],
  ])("canonicalizes %s", (input, expected) => {
    expect(canonicalizeOfficialUrl(input)).toBe(expected);
  });

  it.each([
    "http://example.com/profile",
    "https://user:secret@example.com/profile",
    "https://example.com/profile?q=1",
    "https://example.com/profile#bio",
    "javascript:alert(1)",
    "not a URL",
  ])("rejects unsafe identity %s", (input) => {
    expect(() => canonicalizeOfficialUrl(input)).toThrowError(
      expect.objectContaining({
        code: "CREATOR_PROFILE_OFFICIAL_URL_INVALID",
      }) as CreatorContextError,
    );
  });
});

describe("creator context normalization", () => {
  it("trims values without reordering them", () => {
    expect(normalizeOrderedStrings([" Dota ", "Стримы"], "topics", 3)).toEqual([
      "Dota",
      "Стримы",
    ]);
  });

  it("rejects case-insensitive duplicates instead of silently reordering", () => {
    expect(() =>
      normalizeOrderedStrings(["Dota", " dota "], "topics", 3),
    ).toThrowError(
      expect.objectContaining({ code: "AI_CONTEXT_VALUE_INVALID" }),
    );
  });
});

describe("scoped history cursor", () => {
  it("round-trips only for the exact route tuple", () => {
    const createdAt = new Date("2026-09-06T12:00:00.000Z");
    const id = "10000000-0000-4000-8000-000000000001";
    const cursor = encodeScopedCursor({ scope: "source:1", createdAt, id });
    expect(decodeScopedCursor(cursor, "source:1")).toEqual({ createdAt, id });
    expect(() => decodeScopedCursor(cursor, "source:2")).toThrowError(
      expect.objectContaining({ code: "AI_CONTEXT_CURSOR_INVALID" }),
    );
  });
});
