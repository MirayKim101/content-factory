import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmSourceAuthorization } from "../src/projects/application/confirm-source-authorization.js";
import type { ProjectRepository } from "../src/projects/application/project-repository.port.js";
import type { ProjectView } from "../src/projects/domain/project.js";

const input = {
  projectId: "00000000-0000-4000-8000-000000000001",
  sourceVersion: 1,
  sourceSha256: "a".repeat(64),
  declarationVersion: "source-rights-v1",
  requestId: "request-auth-0001",
};

afterEach(() => vi.restoreAllMocks());

describe("ConfirmSourceAuthorization", () => {
  it("logs the request correlation and safe audit fields on success", async () => {
    const log = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    const repository = {
      confirmSourceAuthorization: vi.fn(async () => ({
        outcome: "CLEARED",
        changed: true,
        project: clearedProject(),
      })),
    } as unknown as ProjectRepository;

    await new ConfirmSourceAuthorization(repository).execute(input);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "source_authorization_confirmed",
        requestId: input.requestId,
        projectId: input.projectId,
        sourceVersion: 1,
        declarationVersion: "source-rights-v1",
        result: "CLEARED",
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.sourceSha256);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sources/");
  });

  it("logs a correlated safe denial and returns the documented conflict", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const repository = {
      confirmSourceAuthorization: vi.fn(async () => ({
        outcome: "SOURCE_VERSION_MISMATCH",
      })),
    } as unknown as ProjectRepository;

    await expect(
      new ConfirmSourceAuthorization(repository).execute(input),
    ).rejects.toMatchObject({
      code: "SOURCE_VERSION_MISMATCH",
      httpStatus: 409,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "source_authorization_denied",
        requestId: input.requestId,
        result: "SOURCE_VERSION_MISMATCH",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(input.sourceSha256);
  });
});

function clearedProject(): ProjectView {
  const now = new Date("2026-09-09T12:00:00.000Z");
  return {
    id: input.projectId,
    name: "Authorized source",
    status: "SOURCE_READY",
    rightsConfirmedAt: null,
    rightsDeclarationVersion: null,
    authorization: {
      status: "CLEARED",
      sourceVersion: 1,
      sourceSha256: input.sourceSha256,
      basis: "EXPLICIT_CONFIRMATION",
      confirmedAt: now,
      declarationVersion: input.declarationVersion,
    },
    createdAt: now,
    updatedAt: now,
    source: {
      id: "00000000-0000-4000-8000-000000000002",
      status: "READY",
      sourceVersion: 1,
      originalFilename: "source.mp4",
      contentType: "video/mp4",
      sizeBytes: 1n,
      sha256: input.sourceSha256,
    },
    artifact: {
      id: "00000000-0000-4000-8000-000000000003",
      role: "SOURCE",
      status: "READY",
      sizeBytes: 1n,
      sha256: input.sourceSha256,
      contentType: "video/mp4",
      lineageSourceId: "00000000-0000-4000-8000-000000000002",
      lineageSourceVersion: 1,
      recipeVersion: "source-ingest-v1",
    },
  };
}
