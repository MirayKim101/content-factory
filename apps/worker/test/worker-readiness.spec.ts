import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearWorkerReadiness,
  markWorkerReady,
  prepareWorkerReadiness,
  tryClearWorkerReadiness,
} from "../src/application/worker-readiness.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("worker readiness", () => {
  it("does not suppress a stale marker directory during startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worker-readiness-"));
    directories.push(directory);
    await mkdir(join(directory, "worker-ready"), { mode: 0o700 });
    await expect(prepareWorkerReadiness(directory)).rejects.toThrow(
      "CONFIG_SCRATCH_UNUSABLE",
    );
    expect((await stat(join(directory, "worker-ready"))).isDirectory()).toBe(
      true,
    );
  });

  it("ignores only ENOENT and reports other unlink failures safely", async () => {
    const missing = vi.fn(async () => {
      throw Object.assign(new Error("private path"), { code: "ENOENT" });
    });
    await expect(
      clearWorkerReadiness("/owned/worker-ready", missing),
    ).resolves.toBeUndefined();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const code of ["EPERM", "EIO", "EROFS", "EISDIR"]) {
      const remove = vi.fn(async () => {
        throw Object.assign(new Error("private path"), { code });
      });
      await expect(
        clearWorkerReadiness("/owned/worker-ready", remove),
      ).rejects.toThrow("CONFIG_SCRATCH_UNUSABLE");
      expect(await tryClearWorkerReadiness("/owned/worker-ready", remove)).toBe(
        false,
      );
    }
    expect(log).toHaveBeenCalledTimes(4);
    for (const [message] of log.mock.calls)
      expect(JSON.parse(message as string)).toEqual({
        event: "worker_readiness_clear_failed",
        code: "CONFIG_SCRATCH_UNUSABLE",
      });
  });
  it("removes a stale marker before startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worker-readiness-"));
    directories.push(directory);
    const readinessFile = join(directory, "worker-ready");
    await writeFile(readinessFile, "stale\n");

    expect(await prepareWorkerReadiness(directory)).toBe(readinessFile);
    await expect(stat(readinessFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes the current process and removes readiness on shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worker-readiness-"));
    directories.push(directory);
    const readinessFile = await prepareWorkerReadiness(directory);

    await markWorkerReady(readinessFile);
    expect(await readFile(readinessFile, "utf8")).toBe(`${process.pid}\n`);

    await clearWorkerReadiness(readinessFile);
    await expect(stat(readinessFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
