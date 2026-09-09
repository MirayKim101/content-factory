import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorialRepository } from "../src/editorial-content/application/editorial-repository.port.js";
import type { EditorialStorage } from "../src/editorial-content/application/editorial-storage.port.js";
import { UploadThumbnail } from "../src/editorial-content/application/upload-thumbnail.js";
import { png } from "./fixtures/thumbnail-fixture.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("thumbnail upload cleanup", () => {
  it("persists intent before object upload and deletes the object after DB finalization failure", async () => {
    const calls: string[] = [];
    const repository = {
      findAssetByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createPendingAsset: vi.fn().mockImplementation(async () => {
        calls.push("intent");
      }),
      finalizeAsset: vi.fn().mockImplementation(async () => {
        calls.push("finalize");
        throw new Error("database unavailable");
      }),
      getAssetFinalization: vi.fn().mockResolvedValue({ status: "PENDING" }),
      failAsset: vi.fn().mockImplementation(async () => {
        calls.push("failed");
      }),
      completeAssetCleanup: vi.fn().mockImplementation(async () => {
        calls.push("cleanup-complete");
      }),
      recordAssetCleanupFailure: vi.fn(),
    } as unknown as EditorialRepository;
    const storage = {
      putFile: vi.fn().mockImplementation(async () => {
        calls.push("object-put");
        return { etag: "etag" };
      }),
      deleteObject: vi.fn().mockImplementation(async () => {
        calls.push("object-delete");
      }),
    } as unknown as EditorialStorage;
    const path = await thumbnailFile();

    await expect(
      new UploadThumbnail(repository, storage).execute({
        projectId: randomUUID(),
        idempotencyKey: "thumbnail-cleanup-0001",
        originalFilename: "cover.png",
        declaredContentType: "image/png",
        filePath: path,
      }),
    ).rejects.toMatchObject({
      code: "THUMBNAIL_FINALIZE_FAILED",
      httpStatus: 500,
    });
    expect(calls).toEqual([
      "intent",
      "object-put",
      "finalize",
      "failed",
      "object-delete",
      "cleanup-complete",
    ]);
    await expect(
      import("node:fs/promises").then(({ stat }) => stat(path)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns an authoritative READY result and never deletes its object after an ambiguous finalize response", async () => {
    const ready = { status: "READY", id: randomUUID() };
    const repository = {
      findAssetByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createPendingAsset: vi.fn(),
      finalizeAsset: vi.fn().mockRejectedValue(new Error("response lost")),
      getAssetFinalization: vi.fn().mockResolvedValue(ready),
      failAsset: vi.fn(),
    } as unknown as EditorialRepository;
    const storage = {
      putFile: vi.fn().mockResolvedValue({ etag: "etag" }),
      deleteObject: vi.fn(),
    } as unknown as EditorialStorage;

    await expect(
      new UploadThumbnail(repository, storage).execute({
        projectId: randomUUID(),
        idempotencyKey: "thumbnail-authoritative-ready",
        originalFilename: "cover.png",
        declaredContentType: "image/png",
        filePath: await thumbnailFile(),
      }),
    ).resolves.toBe(ready);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(repository.failAsset).not.toHaveBeenCalled();
  });

  it("keeps the object for startup reconciliation when finalization state cannot be read", async () => {
    const repository = {
      findAssetByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createPendingAsset: vi.fn(),
      finalizeAsset: vi.fn().mockRejectedValue(new Error("response lost")),
      getAssetFinalization: vi.fn().mockRejectedValue(new Error("db offline")),
      failAsset: vi.fn(),
    } as unknown as EditorialRepository;
    const storage = {
      putFile: vi.fn().mockResolvedValue({ etag: "etag" }),
      deleteObject: vi.fn(),
    } as unknown as EditorialStorage;

    await expect(
      new UploadThumbnail(repository, storage).execute({
        projectId: randomUUID(),
        idempotencyKey: "thumbnail-unknown-finalize",
        originalFilename: "cover.png",
        declaredContentType: "image/png",
        filePath: await thumbnailFile(),
      }),
    ).rejects.toMatchObject({
      code: "THUMBNAIL_FINALIZE_OUTCOME_UNKNOWN",
      httpStatus: 503,
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(repository.failAsset).not.toHaveBeenCalled();
  });
});

async function thumbnailFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "editorial-thumbnail-test-"));
  directories.push(directory);
  const path = join(directory, "thumbnail");
  await writeFile(path, png(1280, 720));
  return path;
}
