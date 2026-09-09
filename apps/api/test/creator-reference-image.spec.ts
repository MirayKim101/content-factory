import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CreatorContextRepository,
  CreatorReferenceAssetView,
} from "../src/ai-content/application/creator-context-repository.port.js";
import type { CreatorContextStorage } from "../src/ai-content/application/creator-context-storage.port.js";
import { CreatorContextService } from "../src/ai-content/application/creator-context.service.js";
import { CreatorContextError } from "../src/ai-content/domain/creator-context.js";
import { StructuralReferenceImageInspector } from "../src/ai-content/infrastructure/reference-image-inspector.js";
import { jpeg, png, webp } from "./fixtures/thumbnail-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("creator reference structural validation", () => {
  const inspector = new StructuralReferenceImageInspector();

  it.each([
    ["image/png", png(1280, 720), 1280, 720],
    ["image/jpeg", jpeg(), 1, 1],
    ["image/webp", webp(), 1, 1],
  ] as const)("accepts real %s bytes", (contentType, bytes, width, height) => {
    expect(inspector.inspect(bytes, contentType)).toEqual({
      contentType,
      width,
      height,
    });
  });

  it.each([
    ["fake MIME", Buffer.from("not-png"), "image/png"],
    ["SVG", Buffer.from("<svg></svg>"), "image/svg+xml"],
    ["truncated", png(1, 1).subarray(0, 20), "image/png"],
    ["pixel bomb", png(40_000_001, 1), "image/png"],
  ])("rejects %s without trusting extension/MIME", (_name, bytes, type) => {
    expect(() => inspector.inspect(bytes, type)).toThrowError(
      CreatorContextError,
    );
  });
});

describe("creator reference upload recovery", () => {
  it("normalizes a Unicode traversal filename and finalizes one private object", async () => {
    const filePath = await temporaryPng();
    const ready = reference("READY");
    const repository = repositoryWith({
      createPendingReference: vi.fn(async (input) => {
        expect(input.originalFilename).toBe("лицо.png");
        expect(input.objectKey).not.toContain("лицо.png");
        return uploadClaim(reference("PENDING"), input.objectKey);
      }),
      finalizeReference: vi.fn().mockResolvedValue(ready),
    });
    const storage = storageWith({ etag: "etag", version: "version" });
    const service = new CreatorContextService(
      repository,
      storage,
      new StructuralReferenceImageInspector(),
    );

    await expect(
      service.uploadReference({
        creatorProfileId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "unicode-upload-key",
        originalFilename: "../../лицо.png",
        declaredContentType: "image/png",
        filePath,
      }),
    ).resolves.toBe(ready);
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(storage.putFile).toHaveBeenCalledOnce();
  });

  it("marks failure and durably cleans an object after storage rejection", async () => {
    const filePath = await temporaryPng();
    const repository = repositoryWith();
    const storage = storageWith();
    vi.mocked(storage.putFile).mockRejectedValueOnce(new Error("secret"));
    const service = new CreatorContextService(
      repository,
      storage,
      new StructuralReferenceImageInspector(),
    );

    await expect(
      service.uploadReference({
        creatorProfileId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "failed-upload-key",
        originalFilename: "face.png",
        declaredContentType: "image/png",
        filePath,
      }),
    ).rejects.toMatchObject({
      code: "CREATOR_REFERENCE_STORAGE_FAILED",
      httpStatus: 503,
    });
    expect(repository.failReference).toHaveBeenCalledWith(
      expect.any(String),
      "CREATOR_REFERENCE_UPLOAD_FAILED",
    );
    expect(storage.deleteObject).toHaveBeenCalledOnce();
    expect(repository.completeReferenceCleanup).toHaveBeenCalledOnce();
  });

  it("rereads an authoritative READY row after an ambiguous finalize", async () => {
    const filePath = await temporaryPng();
    const ready = reference("READY");
    const repository = repositoryWith({
      finalizeReference: vi.fn().mockRejectedValue(new Error("lost response")),
      getReferenceFinalization: vi.fn().mockResolvedValue(ready),
    });
    const service = new CreatorContextService(
      repository,
      storageWith({ etag: "etag" }),
      new StructuralReferenceImageInspector(),
    );

    await expect(
      service.uploadReference({
        creatorProfileId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "ambiguous-upload-key",
        originalFilename: "face.png",
        declaredContentType: "image/png",
        filePath,
      }),
    ).resolves.toBe(ready);
  });
});

async function temporaryPng(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "creator-reference-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "upload.png");
  await writeFile(path, png(2, 2), { mode: 0o600 });
  return path;
}

function reference(
  status: CreatorReferenceAssetView["status"],
): CreatorReferenceAssetView {
  const now = new Date("2026-09-06T00:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000002",
    creatorProfileId: "00000000-0000-4000-8000-000000000001",
    status,
    originalFilename: "face.png",
    contentType: "image/png",
    sizeBytes: 100n,
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
}

function repositoryWith(
  overrides: Partial<CreatorContextRepository> = {},
): CreatorContextRepository {
  return {
    findReferenceUploadReplay: vi.fn().mockResolvedValue(null),
    createPendingReference: vi
      .fn()
      .mockResolvedValue(uploadClaim(reference("PENDING"), "private/object")),
    finalizeReference: vi.fn().mockResolvedValue(reference("READY")),
    getReferenceFinalization: vi.fn().mockResolvedValue(null),
    failReference: vi.fn().mockResolvedValue(undefined),
    completeReferenceCleanup: vi.fn().mockResolvedValue(undefined),
    recordReferenceCleanupFailure: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CreatorContextRepository;
}

function uploadClaim(
  asset: CreatorReferenceAssetView,
  objectKey: string,
  ownsUpload = true,
) {
  return { asset, objectKey, ownsUpload };
}

function storageWith(
  receipt: { etag?: string; version?: string } = {},
): CreatorContextStorage {
  return {
    putFile: vi.fn().mockResolvedValue(receipt),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  } as unknown as CreatorContextStorage;
}
