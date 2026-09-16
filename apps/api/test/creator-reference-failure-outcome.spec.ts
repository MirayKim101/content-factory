import "reflect-metadata";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CreatorContextRepository,
  CreatorReferenceAssetView,
} from "../src/ai-content/application/creator-context-repository.port.js";
import type { CreatorContextStorage } from "../src/ai-content/application/creator-context-storage.port.js";
import { CreatorContextService } from "../src/ai-content/application/creator-context.service.js";
import { StructuralReferenceImageInspector } from "../src/ai-content/infrastructure/reference-image-inspector.js";
import { png } from "./fixtures/thumbnail-fixture.js";

const directories: string[] = [];
const profileId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-16T00:00:00Z");
const pending: CreatorReferenceAssetView = {
  id: "00000000-0000-4000-8000-000000000002",
  creatorProfileId: profileId,
  status: "PENDING",
  originalFilename: "reference.png",
  contentType: "image/png",
  sizeBytes: 1n,
  sha256: "a".repeat(64),
  width: 2,
  height: 2,
  currentAuthorization: {
    id: "00000000-0000-4000-8000-000000000003",
    revision: 1,
    status: "NOT_REVIEWED",
    declarationVersion: null,
    commercialAiImageUseAttested: false,
    basis: null,
    scope: null,
    expiresAt: null,
    externalProviderTransferAllowed: false,
    decidedAt: null,
    createdAt: now,
  },
  createdAt: now,
  updatedAt: now,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cf-reference-outcome-"));
  directories.push(directory);
  const filePath = join(directory, "reference.png");
  await writeFile(filePath, png(2, 2));
  const repository = {
    findReferenceUploadReplay: vi
      .fn<CreatorContextRepository["findReferenceUploadReplay"]>()
      .mockResolvedValue(null),
    createPendingReference: vi
      .fn<CreatorContextRepository["createPendingReference"]>()
      .mockResolvedValue({
        asset: pending,
        objectKey: "owned-reference",
        ownsUpload: true,
      }),
    finalizeReference: vi
      .fn<CreatorContextRepository["finalizeReference"]>()
      .mockRejectedValue(new Error("finalize response lost")),
    getReferenceFinalization: vi
      .fn<CreatorContextRepository["getReferenceFinalization"]>()
      .mockResolvedValue(pending),
    failReference: vi
      .fn<CreatorContextRepository["failReference"]>()
      .mockResolvedValue(undefined),
    completeReferenceCleanup: vi
      .fn<CreatorContextRepository["completeReferenceCleanup"]>()
      .mockResolvedValue(undefined),
    recordReferenceCleanupFailure: vi
      .fn<CreatorContextRepository["recordReferenceCleanupFailure"]>()
      .mockResolvedValue(undefined),
  };
  const storage: CreatorContextStorage = {
    putFile: vi.fn().mockResolvedValue({}),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    headObject: vi.fn().mockResolvedValue(null),
    readObject: vi.fn().mockResolvedValue(null),
  };
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  const service = new CreatorContextService(
    repository as unknown as CreatorContextRepository,
    storage,
    new StructuralReferenceImageInspector(),
  );
  const input = {
    creatorProfileId: profileId,
    idempotencyKey: "exact-upload-attempt",
    originalFilename: "reference.png",
    declaredContentType: "image/png",
    filePath,
  };
  return { repository, storage, service, input };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("creator reference durable failure outcomes", () => {
  for (const phase of ["storage", "finalization"] as const) {
    it(`${phase}: a failed failure-write remains ambiguous and never deletes the object`, async () => {
      const { repository, storage, service, input } = await fixture();
      if (phase === "storage")
        vi.mocked(storage.putFile).mockRejectedValueOnce(
          new Error("storage unavailable"),
        );
      repository.failReference.mockRejectedValueOnce(
        new Error("failure write response lost"),
      );
      await expect(service.uploadReference(input)).rejects.toMatchObject({
        code: "CREATOR_REFERENCE_OUTCOME_UNKNOWN",
        httpStatus: 503,
      });
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(repository.completeReferenceCleanup).not.toHaveBeenCalled();
    });

    it(`${phase}: only a persisted terminal failure permits the terminal error code and cleanup`, async () => {
      const { repository, storage, service, input } = await fixture();
      if (phase === "storage")
        vi.mocked(storage.putFile).mockRejectedValueOnce(
          new Error("storage unavailable"),
        );
      await expect(service.uploadReference(input)).rejects.toMatchObject({
        code:
          phase === "storage"
            ? "CREATOR_REFERENCE_STORAGE_FAILED"
            : "CREATOR_REFERENCE_FINALIZE_FAILED",
        httpStatus: 503,
      });
      expect(repository.failReference).toHaveBeenCalledWith(
        pending.id,
        "CREATOR_REFERENCE_UPLOAD_FAILED",
      );
      expect(storage.deleteObject).toHaveBeenCalledWith("owned-reference");
      expect(repository.completeReferenceCleanup).toHaveBeenCalledWith(
        pending.id,
      );
      expect(repository.failReference.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(storage.deleteObject).mock.invocationCallOrder[0]!,
      );
    });
  }

  it("preserves a READY reference when finalization committed but its response was lost", async () => {
    const { repository, storage, service, input } = await fixture();
    const ready = { ...pending, status: "READY" as const };
    repository.getReferenceFinalization.mockResolvedValueOnce(ready);
    await expect(service.uploadReference(input)).resolves.toEqual(ready);
    expect(repository.failReference).not.toHaveBeenCalled();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
