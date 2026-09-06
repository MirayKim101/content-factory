import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UploadMontageAsset,
  rejectAnimation,
} from "../src/editorial-content/application/upload-montage-asset.js";
import { ReconcileMontageAssets } from "../src/editorial-content/application/reconcile-montage-assets.js";
import type { MontageRepository } from "../src/editorial-content/application/montage-repository.port.js";
import type { ObjectStorage } from "../src/projects/application/object-storage.port.js";
import {
  MontageError,
  montageRightsUsable,
  type StoredMontageAsset,
} from "../src/editorial-content/domain/montage-asset.js";
import { isUuidV4 } from "../src/editorial-content/presentation/montage-identifier.js";
import { normalizeMultipartFilename } from "../src/http/multipart-filename.js";

const directories: string[] = [];
describe("montage UUID validation", () => {
  it("accepts UUID v4 and rejects malformed database identifiers", () => {
    expect(isUuidV4("9cd7ff32-25c4-4ae7-9f7d-3804d9e5ebcb")).toBe(true);
    expect(isUuidV4("------------------------------------")).toBe(false);
    expect(isUuidV4("9cd7ff32-25c4-1ae7-9f7d-3804d9e5ebcb")).toBe(false);
  });
});
describe("multipart filename normalization", () => {
  it("recovers UTF-8 Cyrillic names decoded by multipart as latin1", () => {
    const mojibake = Buffer.from("реклама.mp4", "utf8").toString("latin1");
    expect(normalizeMultipartFilename(mojibake)).toBe("реклама.mp4");
    expect(normalizeMultipartFilename("реклама.mp4")).toBe("реклама.mp4");
  });
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "montage-unit-"));
  directories.push(dir);
  const filePath = join(dir, "video.mp4");
  await writeFile(filePath, "bounded fake video; worker validates it");
  let current: StoredMontageAsset | null = null;
  const repository: MontageRepository = {
    authorize: vi.fn(async () => ({ sourceId: "source", sourceVersion: 1 })),
    findReplay: vi.fn(async () => current),
    create: vi.fn(async (input: Parameters<MontageRepository["create"]>[0]) => {
      const row: StoredMontageAsset = {
        ...input,
        status: "UPLOADING",
        revision: 1,
        probeJob: null,
        failureCode: null,
        failureMessage: null,
        durationMs: null,
        hasAudio: null,
        cleanupStatus: "NOT_REQUIRED",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      current = row;
      return row;
    }),
    finalize: vi.fn(async () => {
      current = { ...current!, status: "PROBE_PENDING", revision: 2 };
      return current;
    }),
    inspect: vi.fn(async () => current),
    get: vi.fn(async () => current),
    list: vi.fn(async () => (current ? [current] : [])),
    recoverable: vi.fn(async () => (current ? [current] : [])),
    failUpload: vi.fn(async () => {
      current = {
        ...current!,
        status: "FAILED_FINAL",
        cleanupStatus: "PENDING",
      };
      return true;
    }),
    completeCleanup: vi.fn(async () => {}),
    cleanupFailed: vi.fn(async () => {}),
  };
  const storage: ObjectStorage = {
    ensurePrivateBucket: vi.fn(async () => {}),
    putFile: vi.fn(async () => ({ etag: "etag" })),
    headObject: vi.fn(async () => null),
    deleteObject: vi.fn(async () => {}),
  };
  const input = {
    projectId: "project",
    kind: "INTRO" as const,
    idempotencyKey: "montage-test-key",
    originalFilename: "intro.mp4",
    declaredContentType: "video/mp4",
    filePath,
  };
  return {
    dir,
    filePath,
    repository,
    storage,
    input,
    upload: new UploadMontageAsset(repository, storage),
    current: () => current,
  };
}
describe("montage upload lifecycle", () => {
  it("persists intent/checksum before private write and finalization", async () => {
    const t = await setup();
    const sha = createHash("sha256")
      .update(await readFile(t.filePath))
      .digest("hex");
    const asset = await t.upload.execute(t.input);
    expect(asset).toMatchObject({
      kind: "INTRO",
      status: "PROBE_PENDING",
      sha256: sha,
      revision: 2,
    });
    expect(
      vi.mocked(t.repository.create).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(t.storage.putFile).mock.invocationCallOrder[0]!);
    await expect(readFile(t.filePath)).rejects.toThrow();
  });
  it("replays identity without another write and rejects changed payload", async () => {
    const t = await setup();
    const bytes = await readFile(t.filePath);
    const first = await t.upload.execute(t.input);
    await writeFile(t.filePath, bytes);
    expect((await t.upload.execute(t.input)).id).toBe(first.id);
    await writeFile(t.filePath, bytes);
    await expect(
      t.upload.execute({ ...t.input, kind: "OUTRO" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(t.storage.putFile).toHaveBeenCalledOnce();
  });
  it("leaves recoverable durable intent after storage ambiguity", async () => {
    const t = await setup();
    vi.mocked(t.storage.putFile).mockRejectedValue(new Error("network"));
    await expect(t.upload.execute(t.input)).rejects.toMatchObject({
      code: "MONTAGE_STORAGE_RETRYABLE",
    });
    expect(t.current()?.status).toBe("UPLOADING");
    expect(t.storage.deleteObject).not.toHaveBeenCalled();
  });
  it("rereads an ambiguous finalization without deleting committed content", async () => {
    const t = await setup();
    vi.mocked(t.repository.finalize).mockRejectedValueOnce(
      new Error("commit unknown"),
    );
    await expect(t.upload.execute(t.input)).rejects.toMatchObject({
      code: "MONTAGE_FINALIZATION_RETRYABLE",
    });
    expect(t.repository.inspect).toHaveBeenCalled();
    expect(t.storage.deleteObject).not.toHaveBeenCalled();
  });
  it("returns the committed asset when finalization reports an ambiguous error", async () => {
    const t = await setup();
    const finish = vi.mocked(t.repository.finalize).getMockImplementation()!;
    vi.mocked(t.repository.finalize).mockImplementationOnce(async (...args) => {
      await finish(...args);
      throw new Error("commit response lost");
    });
    expect((await t.upload.execute(t.input)).status).toBe("PROBE_PENDING");
    expect(t.storage.deleteObject).not.toHaveBeenCalled();
  });
  it("denies authorization before writes", async () => {
    const t = await setup();
    vi.mocked(t.repository.authorize).mockRejectedValue(
      new MontageError("MONTAGE_RIGHTS_REQUIRED", "Denied", 403),
    );
    await expect(t.upload.execute(t.input)).rejects.toMatchObject({
      httpStatus: 403,
    });
    expect(t.repository.create).not.toHaveBeenCalled();
    expect(t.storage.putFile).not.toHaveBeenCalled();
  });
  it("rejects declared MIME mismatch and corrupt banners without storing", async () => {
    const t = await setup();
    await expect(
      t.upload.execute({ ...t.input, declaredContentType: "text/plain" }),
    ).rejects.toMatchObject({ code: "MONTAGE_MIME_UNSUPPORTED" });
    await writeFile(t.filePath, "not an image");
    await expect(
      t.upload.execute({
        ...t.input,
        kind: "BANNER",
        declaredContentType: "image/png",
      }),
    ).rejects.toThrow();
    expect(t.storage.putFile).not.toHaveBeenCalled();
  });
  it("reconciles exact upload receipts into durable probe intent", async () => {
    const t = await setup();
    vi.mocked(t.storage.putFile).mockRejectedValue(new Error("network"));
    await t.upload.execute(t.input).catch(() => {});
    vi.mocked(t.storage.headObject).mockResolvedValue({
      sha256: t.current()!.sha256,
      sizeBytes: Number(t.current()!.sizeBytes),
    });
    await new ReconcileMontageAssets(t.repository, t.storage).execute();
    expect(t.repository.finalize).toHaveBeenCalledOnce();
    expect(t.storage.deleteObject).not.toHaveBeenCalled();
  });
  it("persists cleanup intent before deleting incomplete objects", async () => {
    const t = await setup();
    vi.mocked(t.storage.putFile).mockRejectedValue(new Error("network"));
    await t.upload.execute(t.input).catch(() => {});
    await new ReconcileMontageAssets(t.repository, t.storage).execute();
    expect(
      vi.mocked(t.repository.failUpload).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(t.storage.deleteObject).mock.invocationCallOrder[0]!,
    );
    expect(t.repository.completeCleanup).toHaveBeenCalledOnce();
  });
  it("does not accept local montage rights in manual policy", () => {
    const evidence = {
      rightsBasis: "LOCAL_DEVELOPMENT_AUTO",
      rightsDeclaration: "montage-local-development-auto-v1",
      rightsDecidedAt: new Date(),
    };
    expect(montageRightsUsable(evidence, "manual")).toBe(false);
    expect(montageRightsUsable(evidence, "local-auto")).toBe(true);
  });
  it("rejects animated PNG/WebP chunks", () => {
    const png = Buffer.alloc(20);
    png.write("acTL", 12);
    expect(() => rejectAnimation(png, "image/png")).toThrow("Animated");
    const webp = Buffer.alloc(20);
    webp.write("ANIM", 12);
    expect(() => rejectAnimation(webp, "image/webp")).toThrow("Animated");
  });
});
