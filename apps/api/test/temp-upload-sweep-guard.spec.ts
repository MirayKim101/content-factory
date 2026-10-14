import { describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));
const synchronousFilesystem = vi.hoisted(() => ({ chmodSync: vi.fn() }));
const environment = vi.hoisted(() => ({ rootDirectory: "/fixture/uploads" }));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  ...synchronousFilesystem,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  ...filesystem,
}));
vi.mock("../src/config/environment.js", () => ({
  apiEnvironment: () => ({
    uploadTempDirectory: environment.rootDirectory,
    uploadTempStaleAfterMs: 1_000,
    uploadTempSweepLimit: 1,
  }),
}));

import { TempUploadSweepStartup } from "../src/projects/infrastructure/temp-upload-sweep.startup.js";
import { UploadStagingUnavailableException } from "../src/projects/presentation/upload-staging-admission.service.js";

describe("TempUploadSweepStartup staging-root guard", () => {
  function privateDirectory(): object {
    return {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o700,
      uid: process.getuid?.() ?? 0,
    };
  }

  function reset(): void {
    environment.rootDirectory = "/fixture/uploads";
    filesystem.lstat.mockReset();
    filesystem.mkdir.mockReset();
    filesystem.readdir.mockReset();
    filesystem.rm.mockReset();
    filesystem.stat.mockReset();
    synchronousFilesystem.chmodSync.mockReset();
  }

  it("rejects a protected raw root before readdir or rm", async () => {
    reset();
    environment.rootDirectory = "/fixture/Se\u00e1nova/../uploads";

    await expect(new TempUploadSweepStartup().sweep()).rejects.toBeInstanceOf(
      UploadStagingUnavailableException,
    );
    expect(filesystem.lstat).not.toHaveBeenCalled();
    expect(filesystem.readdir).not.toHaveBeenCalled();
    expect(filesystem.rm).not.toHaveBeenCalled();
  });

  it("rejects a symlinked ancestor before readdir or rm", async () => {
    reset();
    filesystem.lstat.mockResolvedValue({
      isDirectory: () => false,
      isSymbolicLink: () => true,
      mode: 0o777,
      uid: process.getuid?.() ?? 0,
    });

    await expect(new TempUploadSweepStartup().sweep()).rejects.toBeInstanceOf(
      UploadStagingUnavailableException,
    );
    expect(filesystem.readdir).not.toHaveBeenCalled();
    expect(filesystem.rm).not.toHaveBeenCalled();
  });

  it("rejects a nonprivate existing root without chmod repair", async () => {
    reset();
    environment.rootDirectory = "/fixture";
    filesystem.lstat.mockResolvedValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
      uid: process.getuid?.() ?? 0,
    });

    await expect(new TempUploadSweepStartup().sweep()).rejects.toBeInstanceOf(
      UploadStagingUnavailableException,
    );
    expect(synchronousFilesystem.chmodSync).not.toHaveBeenCalled();
    expect(filesystem.readdir).not.toHaveBeenCalled();
  });

  it("keeps ENOENT after a healthy root check as an empty sweep", async () => {
    reset();
    filesystem.lstat.mockResolvedValue(privateDirectory());
    filesystem.readdir.mockRejectedValue(
      Object.assign(new Error("gone"), {
        code: "ENOENT",
      }),
    );

    await expect(new TempUploadSweepStartup().sweep()).resolves.toBe(0);
    expect(filesystem.rm).not.toHaveBeenCalled();
  });
});
