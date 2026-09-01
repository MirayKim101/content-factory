import { access, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TempUploadSweepStartup } from "../src/projects/infrastructure/temp-upload-sweep.startup.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  delete process.env.API_UPLOAD_TEMP_DIRECTORY;
  delete process.env.API_UPLOAD_TEMP_STALE_AFTER_MS;
  delete process.env.API_UPLOAD_TEMP_SWEEP_LIMIT;
});

describe("TempUploadSweepStartup", () => {
  it("removes only bounded, owned request directories older than TTL", async () => {
    root = await mkdtemp(join(tmpdir(), "content-factory-sweep-"));
    process.env.API_UPLOAD_TEMP_DIRECTORY = root;
    process.env.API_UPLOAD_TEMP_STALE_AFTER_MS = "1000";
    process.env.API_UPLOAD_TEMP_SWEEP_LIMIT = "1";
    const old = join(root, "request-old");
    const oldSecond = join(root, "request-old-second");
    const unrelated = join(root, "unrelated");
    await Promise.all([mkdir(old), mkdir(oldSecond), mkdir(unrelated)]);
    await utimes(old, new Date(0), new Date(0));
    await utimes(oldSecond, new Date(0), new Date(0));

    await expect(new TempUploadSweepStartup().sweep(Date.now())).resolves.toBe(
      1,
    );

    const remainingOld = await Promise.allSettled([
      access(old),
      access(oldSecond),
    ]);
    expect(
      remainingOld.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(access(unrelated)).resolves.toBeUndefined();
  });
});
