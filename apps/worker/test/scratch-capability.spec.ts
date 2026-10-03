import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScratchCapabilityError,
  usableScratchFilesystem,
  verifyScratchCapability,
} from "../src/infrastructure/scratch-capability.js";
import { prepareWorkerReadiness } from "../src/application/worker-readiness.js";

const directories: string[] = [];
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cf-scratch-capability-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("scratch capability before worker readiness", () => {
  it("creates private missing roots and leaves no exclusive probe behind", async () => {
    const base = await fixture();
    const root = join(base, "nested", "scratch");
    await verifyScratchCapability(root);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toEqual([]);
    await verifyScratchCapability(root);
    expect(await readdir(root)).toEqual([]);
  });

  it("never follows an ancestor symlink or alters its target", async () => {
    const base = await fixture();
    const target = await fixture();
    await writeFile(join(target, "sentinel"), "unchanged");
    await symlink(target, join(base, "alias"));
    await expect(
      verifyScratchCapability(join(base, "alias", "new")),
    ).rejects.toBeInstanceOf(ScratchCapabilityError);
    expect(await readdir(target)).toEqual(["sentinel"]);
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("unchanged");
  });

  it("rejects forbidden lexical paths before materializing any directory", async () => {
    const base = await fixture();
    for (const name of ["Seanova", "Seánova", "SeAnOvA-NeW", "dockerServer"]) {
      await expect(
        verifyScratchCapability(join(base, name, "scratch")),
      ).rejects.toThrow("CONFIG_SCRATCH_UNUSABLE");
    }
    expect(await readdir(base)).toEqual([]);
  });

  it("does not chmod an existing nonprivate root into a different policy", async () => {
    const root = await fixture();
    await chmod(root, 0o755);
    await expect(verifyScratchCapability(root)).rejects.toThrow(
      "CONFIG_SCRATCH_UNUSABLE",
    );
    expect((await lstat(root)).mode & 0o777).toBe(0o755);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects read-only modes and non-directory roots without readiness", async () => {
    const root = await fixture();
    await chmod(root, 0o500);
    await expect(prepareWorkerReadiness(root)).rejects.toThrow(
      "CONFIG_SCRATCH_UNUSABLE",
    );
    expect(await readdir(root)).toEqual([]);
    await chmod(root, 0o700);
    const file = join(root, "ordinary-file");
    await writeFile(file, "unchanged");
    await expect(prepareWorkerReadiness(file)).rejects.toThrow(
      "CONFIG_SCRATCH_UNUSABLE",
    );
    expect(await readFile(file, "utf8")).toBe("unchanged");
  });

  it("rejects malformed statfs without imposing a free-space admission threshold", () => {
    const disk = {
      bsize: 4096n,
      blocks: 100n,
      bfree: 0n,
      bavail: 0n,
      files: 10n,
      ffree: 0n,
    };
    expect(usableScratchFilesystem(disk)).toBe(true);
    for (const changed of [
      { bsize: 0n },
      { blocks: 0n },
      { bfree: -1n },
      { bavail: 1n },
      { files: -1n },
      { ffree: 11n },
    ])
      expect(usableScratchFilesystem({ ...disk, ...changed })).toBe(false);
  });
});
