import { describe, expect, it } from "vitest";
import {
  PUBLIC_APPROVAL_CITATION_MAX_COUNT,
  projectPublicApprovalCitations,
} from "@content-factory/contracts";

import {
  normalizePublicCitationUrl,
  PUBLIC_CITATION_URL_POLICY_VERSION,
} from "../src/ai-content/research/public-citation-url.js";
import { PrismaResearchSuggestionRepository } from "../src/ai-content/infrastructure/prisma-research-suggestion.repository.js";
import type { PrismaService } from "../src/database/prisma.service.js";

describe(PUBLIC_CITATION_URL_POLICY_VERSION, () => {
  const publicCitation = {
    id: "00000000-0000-4000-8000-000000000001",
    url: "https://example.com/source",
    title: "Source",
    publisher: "Example",
    publishedAt: null,
    accessedAt: "2026-09-25T00:00:00.000Z",
  } as const;

  it("projects only exact bounded public approval citation fields", () => {
    expect(projectPublicApprovalCitations([publicCitation])).toEqual([
      publicCitation,
    ]);
    expect(
      projectPublicApprovalCitations([
        { ...publicCitation, credentials: "secret", excerpt: "private" },
      ]),
    ).toBeNull();
    expect(
      projectPublicApprovalCitations(
        Array.from(
          { length: PUBLIC_APPROVAL_CITATION_MAX_COUNT + 1 },
          (_, index) => ({
            ...publicCitation,
            id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          }),
        ),
      ),
    ).toBeNull();
  });

  it("normalizes bounded public query strings without removing them", () => {
    expect(
      normalizePublicCitationUrl(
        "https://EXAMPLE.com/article?page=2&q=public%20facts&utm_source=operator",
      ),
    ).toBe(
      "https://example.com/article?page=2&q=public+facts&utm_source=operator",
    );
    expect(
      normalizePublicCitationUrl("https://example.com/?expires=tomorrow"),
    ).toBe("https://example.com/?expires=tomorrow");
  });

  it.each([
    "https://example.com/a?X-Amz-Signature=secret&X-Amz-Expires=60",
    "https://example.com/a?SIGNATURE=secret",
    "https://example.com/a?X-Goog-Credential=secret",
    "https://example.com/a?sig=secret",
    "https://example.com/a?token=secret",
    "https://example.com/a?ACCESS_TOKEN=secret",
    "https://example.com/a?key=secret",
    "https://example.com/a?credential=secret",
    "https://example.com/a?sv=2026-01-01&sp=r&se=tomorrow",
  ])(
    "rejects signed or credential-bearing URLs without returning them",
    (url) => {
      expect(normalizePublicCitationUrl(url)).toBeNull();
    },
  );

  it.each([
    "https://localhost/article",
    "https://service.internal/article",
    "https://127.0.0.1/article",
    "https://10.0.0.1/article",
    "https://192.168.1.2/article",
    "https://[::1]/article",
  ])("rejects non-public citation hosts", (url) => {
    expect(normalizePublicCitationUrl(url)).toBeNull();
  });

  it("rejects a signed URL at research admission without echoing its secret", async () => {
    const secret = "must-not-appear-in-error";
    const repository = new PrismaResearchSuggestionRepository(
      {} as PrismaService,
    );
    let rejection: unknown;
    try {
      await repository.create({
        transcriptIntentId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "citation-policy-test",
        query: "bounded query",
        citations: [
          {
            url: `https://example.com/a?X-Goog-Signature=${secret}`,
            title: "Source",
            publisher: "Example",
            excerpt: "Evidence",
          },
        ],
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ code: "RESEARCH_CITATION_INVALID" });
    expect(String(rejection)).not.toContain(secret);
  });
});
