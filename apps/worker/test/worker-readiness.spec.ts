import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearWorkerReadiness,
  markWorkerReady,
  prepareWorkerReadiness,
} from "../src/application/worker-readiness.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("worker readiness", () => {
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
