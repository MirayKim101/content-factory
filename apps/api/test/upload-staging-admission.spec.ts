import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  chmod: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  statfs: vi.fn(),
}));
const synchronousFilesystem = vi.hoisted(() => ({ chmodSync: vi.fn() }));

const environment = vi.hoisted(() => ({
  rootDirectory: "/fixture/uploads",
  safetyBytes: 100,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...filesystem,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  ...synchronousFilesystem,
}));

vi.mock("../src/config/environment.js", () => ({
  apiEnvironment: () => ({
    uploadTempDirectory: environment.rootDirectory,
    uploadStagingSafetyBytes: environment.safetyBytes,
  }),
}));

import {
  UploadStagingAdmissionService,
  type UploadStagingReservation,
  UploadStagingUnavailableException,
} from "../src/projects/presentation/upload-staging-admission.service.js";

describe("upload staging admission", () => {
  beforeEach(() => {
    environment.rootDirectory = "/fixture/uploads";
    environment.safetyBytes = 100;
    filesystem.chmod.mockReset();
    synchronousFilesystem.chmodSync.mockReset();
    filesystem.lstat.mockReset();
    filesystem.mkdir.mockReset();
    filesystem.statfs.mockReset();
  });

  function setupFilesystem(): void {
    filesystem.mkdir.mockResolvedValue(undefined);
    filesystem.lstat.mockImplementation(
      async (_pathname: string, options?: { bigint?: boolean }) => {
        if (options?.bigint) return { dev: 17n };
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
          mode: 0o700,
          uid: process.getuid?.() ?? 0,
        };
      },
    );
    filesystem.statfs.mockResolvedValue({
      bavail: 1_000n,
      bfree: 1_000n,
      blocks: 1_000n,
      bsize: 1n,
    });
  }

  it("rejects protected staging paths before filesystem access", async () => {
    environment.rootDirectory = "/fixture/Se\u00e1nova/../uploads";

    await expect(
      new UploadStagingAdmissionService().reserve(1),
    ).rejects.toBeInstanceOf(UploadStagingUnavailableException);
    expect(filesystem.lstat).not.toHaveBeenCalled();
    expect(filesystem.mkdir).not.toHaveBeenCalled();
  });

  it("rejects a symlinked parent without probing its target", async () => {
    environment.rootDirectory = "/fixture/uploads";
    filesystem.lstat.mockResolvedValue({
      isDirectory: () => false,
      isSymbolicLink: () => true,
      mode: 0o777,
      uid: process.getuid?.() ?? 0,
    });

    await expect(
      new UploadStagingAdmissionService().reserve(1),
    ).rejects.toBeInstanceOf(UploadStagingUnavailableException);
    expect(filesystem.statfs).not.toHaveBeenCalled();
  });

  it.each([0o1700, 0o2700, 0o4700, 0o7700])(
    "rejects an existing staging root with special permission bits (%i), without repair",
    async (mode) => {
      setupFilesystem();
      filesystem.lstat.mockResolvedValue({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        mode: 0o40000 | mode,
        uid: process.getuid?.() ?? 0,
      });

      await expect(
        new UploadStagingAdmissionService().reserve(1),
      ).rejects.toBeInstanceOf(UploadStagingUnavailableException);
      expect(filesystem.statfs).not.toHaveBeenCalled();
      expect(filesystem.mkdir).not.toHaveBeenCalled();
      expect(filesystem.chmod).not.toHaveBeenCalled();
      expect(synchronousFilesystem.chmodSync).not.toHaveBeenCalled();
    },
  );

  it("fails closed for malformed filesystem capacity statistics", async () => {
    setupFilesystem();
    filesystem.statfs.mockResolvedValue({
      bavail: 2n,
      bfree: 1n,
      blocks: 1n,
      bsize: 1n,
    });

    await expect(
      new UploadStagingAdmissionService().reserve(1),
    ).rejects.toBeInstanceOf(UploadStagingUnavailableException);
  });

  it("treats a valid zero-capacity filesystem as unavailable", async () => {
    setupFilesystem();
    filesystem.statfs.mockResolvedValue({
      bavail: 0n,
      bfree: 0n,
      blocks: 1_000n,
      bsize: 1n,
    });

    await expect(
      new UploadStagingAdmissionService().reserve(1),
    ).rejects.toBeInstanceOf(UploadStagingUnavailableException);
  });

  it("reserves maximum bytes concurrently and defers release until the writer closes", async () => {
    setupFilesystem();
    const service = new UploadStagingAdmissionService();
    const attempts = await Promise.allSettled([
      service.reserve(800),
      service.reserve(800),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    const reservation = attempts.find(
      (attempt): attempt is PromiseFulfilledResult<UploadStagingReservation> =>
        attempt.status === "fulfilled",
    )?.value;
    expect(reservation).toBeDefined();
    if (!reservation) throw new Error("fixture reservation missing");
    const closeWriter = reservation.beginWriter();
    reservation.release();

    await expect(service.reserve(101)).rejects.toBeInstanceOf(
      UploadStagingUnavailableException,
    );

    closeWriter();
    await expect(service.reserve(101)).resolves.toBeDefined();
  });

  it("returns the generic unavailable response for statfs failure", async () => {
    setupFilesystem();
    filesystem.statfs.mockRejectedValue(new Error("fixture statfs failure"));

    await expect(
      new UploadStagingAdmissionService().reserve(1),
    ).rejects.toMatchObject({
      status: 503,
      response: {
        code: "UPLOAD_STAGING_UNAVAILABLE",
        message: "Upload staging capacity is temporarily unavailable.",
      },
    });
  });

  it("keeps every current Multer endpoint on the shared lifecycle and metadata", async () => {
    const root = resolve(import.meta.dirname, "../src");
    const files = [
      "projects/presentation/projects.controller.ts",
      "editorial-content/presentation/montage.controller.ts",
      "editorial-content/presentation/editorial.controller.ts",
      "ai-content/presentation/creator-context.controller.ts",
    ];
    const sources = await Promise.all(
      files.map((file) => readFile(resolve(root, file), "utf8")),
    );
    expect(sources).toHaveLength(4);
    for (const source of sources) {
      expect(source).toContain("UploadStagingAdmission(");
      expect(source).toContain("TempUploadLifecycleInterceptor");
      expect(source).toContain("FileInterceptor(");
    }
  });
});
