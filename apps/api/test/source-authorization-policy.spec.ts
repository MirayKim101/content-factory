import { describe, expect, it, vi } from "vitest";

import type { ProjectRepository } from "../src/projects/application/project-repository.port.js";
import { SourceAuthorizationPolicy } from "../src/projects/application/source-authorization-policy.js";

describe("SourceAuthorizationPolicy", () => {
  it("allows only a cleared exact source tuple and fails closed", async () => {
    const cleared = {
      sourceId: "00000000-0000-4000-8000-000000000001",
      sourceVersion: 2,
      sourceSha256: "a".repeat(64),
    };
    const repository = {
      isSourceAuthorized: vi.fn(async (id, version, sha256) =>
        Promise.resolve(
          id === cleared.sourceId &&
            version === cleared.sourceVersion &&
            sha256 === cleared.sourceSha256,
        ),
      ),
    } as unknown as ProjectRepository;
    const policy = new SourceAuthorizationPolicy(repository);

    await expect(
      policy.isCleared(
        cleared.sourceId,
        cleared.sourceVersion,
        cleared.sourceSha256,
      ),
    ).resolves.toBe(true);
    await expect(
      policy.isCleared(
        "00000000-0000-4000-8000-000000000099",
        2,
        cleared.sourceSha256,
      ),
    ).resolves.toBe(false);
    await expect(
      policy.isCleared(cleared.sourceId, 1, cleared.sourceSha256),
    ).resolves.toBe(false);
    await expect(
      policy.isCleared(cleared.sourceId, 2, "b".repeat(64)),
    ).resolves.toBe(false);
  });

  it("denies when authorization persistence cannot be read", async () => {
    const repository = {
      isSourceAuthorized: vi.fn(async () => false),
    } as unknown as ProjectRepository;
    await expect(
      new SourceAuthorizationPolicy(repository).isCleared(
        "source",
        1,
        "a".repeat(64),
      ),
    ).resolves.toBe(false);
  });
});
