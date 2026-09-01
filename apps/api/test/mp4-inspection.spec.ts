import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectMp4 } from "../src/projects/application/mp4-inspection.js";
import {
  emptySampleTableMp4,
  invalidChunkOffsetMp4,
  noTrackMp4,
  tinyMp4,
} from "./fixtures/mp4-fixture.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("inspectMp4", () => {
  it("accepts an MP4 structure and calculates its SHA-256", async () => {
    const directory = await mkdtemp(join(tmpdir(), "content-factory-mp4-"));
    directories.push(directory);
    const path = join(directory, "source.bin");
    await writeFile(path, tinyMp4());

    const result = await inspectMp4(path);

    expect(result.contentType).toBe("video/mp4");
    expect(result.sizeBytes).toBe(1494n);
    expect(result.sha256).toBe(
      "a901150457a87eb8ff4f7c43137f8c6c8c8ab1396274dc76db49b98fc12f3692",
    );
  });

  it("rejects extension and MIME spoofing without a real MP4 structure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "content-factory-mp4-"));
    directories.push(directory);
    const path = join(directory, "fake.mp4");
    await writeFile(path, "not a video");

    await expect(inspectMp4(path)).rejects.toMatchObject({
      code: "INVALID_MP4",
      httpStatus: 415,
    });
  });

  it("rejects an MP4-shaped file without video track metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "content-factory-mp4-"));
    directories.push(directory);
    const path = join(directory, "no-track.mp4");
    await writeFile(path, noTrackMp4());

    await expect(inspectMp4(path)).rejects.toMatchObject({
      code: "INVALID_MP4",
    });
  });

  it.each([
    ["an empty sample table", emptySampleTableMp4],
    ["a chunk offset outside mdat", invalidChunkOffsetMp4],
  ])("rejects %s", async (_description, fixture) => {
    const directory = await mkdtemp(join(tmpdir(), "content-factory-mp4-"));
    directories.push(directory);
    const path = join(directory, "corrupt-table.mp4");
    await writeFile(path, fixture());

    await expect(inspectMp4(path)).rejects.toMatchObject({
      code: "INVALID_MP4",
    });
  });
});
