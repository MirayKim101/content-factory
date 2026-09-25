import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { EditorialExportPlan } from "../src/domain/media-job.js";
import { StreamingZip64PackageExporter } from "../src/infrastructure/streaming-zip64-package-exporter.js";

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("streaming ZIP64 editorial package", () => {
  it("writes deterministic safe entries and exact manifest checksums", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-export-zip64-"));
    directories.push(directory);
    const video = Buffer.alloc(2 * 1024 * 1024 + 7, 0x41);
    const thumbnail = Buffer.from("fake-jpeg-content");
    const videoPath = join(directory, "source.mp4");
    const thumbnailPath = join(directory, "thumb.jpg");
    await Promise.all([
      writeFile(videoPath, video),
      writeFile(thumbnailPath, thumbnail),
    ]);
    const plan = exportPlan(video, thumbnail);
    const exporter = new StreamingZip64PackageExporter();
    const openInput = async (objectKey: string) =>
      createReadStream(objectKey === "video-key" ? videoPath : thumbnailPath);
    const firstPath = join(directory, "first.zip");
    const secondPath = join(directory, "second.zip");
    const first = await exporter.export({
      plan,
      outputPath: firstPath,
      signal: new AbortController().signal,
      openInput,
      onProgress: () => undefined,
    });
    const second = await exporter.export({
      plan,
      outputPath: secondPath,
      signal: new AbortController().signal,
      openInput,
      onProgress: () => undefined,
    });
    expect(await readFile(secondPath)).toEqual(await readFile(firstPath));
    expect(second).toEqual(first);

    const entries = await readStoredZipEntries(firstPath);
    expect([...entries.keys()]).toEqual([
      "video.mp4",
      "thumbnail.jpg",
      "metadata.txt",
      "metadata.json",
      "manifest.json",
    ]);
    expect(entries.get("video.mp4")).toEqual(video);
    expect(entries.get("thumbnail.jpg")).toEqual(thumbnail);
    const metadataText = entries.get("metadata.txt")?.toString("utf8");
    expect(metadataText).toBe(
      "TITLE\nТочный заголовок\n\nDESCRIPTION\nСтрока 1\nСтрока 2\n\nTAGS\nfirst\nвторой\n",
    );
    const manifestBytes = entries.get("manifest.json");
    expect(manifestBytes).toBeDefined();
    if (!manifestBytes) throw new Error("manifest.json was not written");
    expect(manifestBytes.at(-1)).toBe(10);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      entries: Array<{ name: string; sizeBytes: string; sha256: string }>;
    };
    expect(manifest.entries.map((value) => value.name)).toEqual([
      "video.mp4",
      "thumbnail.jpg",
      "metadata.txt",
      "metadata.json",
    ]);
    expect(
      manifest.entries.some((value) => value.name === "manifest.json"),
    ).toBe(false);
    for (const entry of manifest.entries) {
      const bytes = entries.get(entry.name);
      expect(bytes).toBeDefined();
      if (!bytes) throw new Error(`${entry.name} was not written`);
      expect(entry.sizeBytes).toBe(String(bytes.length));
      expect(entry.sha256).toBe(sha256(bytes));
    }
    expect(first.archiveBytes).toBe(BigInt((await readFile(firstPath)).length));
  }, 20_000);

  it("rejects tampered input without creating a usable package", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-export-tamper-"));
    directories.push(directory);
    const video = Buffer.from("video");
    const thumbnail = Buffer.from("thumbnail");
    const plan = exportPlan(video, thumbnail);
    await expect(
      new StreamingZip64PackageExporter().export({
        plan,
        outputPath: join(directory, "tampered.zip"),
        signal: new AbortController().signal,
        openInput: async () => createReadStream("/dev/null"),
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "EXPORT_INPUT_IDENTITY_MISMATCH" });
  });

  it("serializes the exact v2 approval snapshot deterministically without changing the five-entry contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-export-v2-"));
    directories.push(directory);
    const video = Buffer.from("v2-video");
    const thumbnail = Buffer.from("v2-thumbnail");
    const videoPath = join(directory, "video.mp4");
    const thumbnailPath = join(directory, "thumbnail.jpg");
    await Promise.all([
      writeFile(videoPath, video),
      writeFile(thumbnailPath, thumbnail),
    ]);
    const plan = exportPlan(video, thumbnail);
    plan.approvalContractVersion = "human-horizontal-approval-v2";
    plan.exportContractVersion = "editorial-export-zip-v2";
    plan.approvalSnapshot = {
      fingerprintBasisVersion: "editorial-approval-fingerprint-v2-iso8601",
      workflowMode: "MIXED",
      components: [
        {
          component: "METADATA",
          mode: "AI_ASSISTED",
          citations: [{ id: randomUUID(), url: "https://example.test/source" }],
          directCostMicrousd: "0",
        },
        {
          component: "THUMBNAIL",
          mode: "MANUAL",
          likeness: null,
          directCostMicrousd: "0",
        },
      ],
      economics: {
        schemaVersion: "approval-economics-v2",
        combinedDirectCostMicrousd: "0",
      },
      processingMetrics: {
        metricsSchemaVersion: "approval-metrics-v1",
        outputBytes: "8",
      },
    };
    const outputPath = join(directory, "v2.zip");
    const reorderedOutputPath = join(directory, "v2-reordered.zip");
    const exporter = new StreamingZip64PackageExporter();
    const openInput = async (key: string) =>
      createReadStream(key === "video-key" ? videoPath : thumbnailPath);
    const result = await exporter.export({
      plan,
      outputPath,
      signal: new AbortController().signal,
      openInput,
      onProgress: () => undefined,
    });
    const reorderedResult = await exporter.export({
      plan: reverseObjectInsertionOrder(plan) as EditorialExportPlan,
      outputPath: reorderedOutputPath,
      signal: new AbortController().signal,
      openInput,
      onProgress: () => undefined,
    });
    expect(result.manifest).toMatchObject({
      manifestSchemaVersion: "editorial-export-manifest-v2",
      exportContractVersion: "editorial-export-zip-v2",
      approvalSnapshot: { workflowMode: "MIXED" },
    });
    const entries = await readStoredZipEntries(outputPath);
    const metadataBytes = entries.get("metadata.json");
    const manifestBytes = entries.get("manifest.json");
    expect(metadataBytes).toBeDefined();
    expect(manifestBytes).toBeDefined();
    if (!metadataBytes || !manifestBytes)
      throw new Error("v2 metadata or manifest was not written");
    expect(JSON.parse(metadataBytes.toString("utf8"))).toMatchObject({
      metadataSchemaVersion: "editorial-metadata-v2",
      workflowMode: "MIXED",
    });
    expect(JSON.parse(manifestBytes.toString("utf8"))).toEqual(result.manifest);
    const reorderedEntries = await readStoredZipEntries(reorderedOutputPath);
    expect(reorderedEntries.get("manifest.json")).toEqual(manifestBytes);
    expect(await readFile(reorderedOutputPath)).toEqual(
      await readFile(outputPath),
    );
    expect(reorderedResult.manifest).toEqual(result.manifest);
    expect(manifestBytes.at(-1)).toBe(10);
  });

  it.each(["size", "checksum"] as const)(
    "rejects an input whose frozen %s identity changed",
    async (identityPart) => {
      const directory = await mkdtemp(join(tmpdir(), "cf-export-identity-"));
      directories.push(directory);
      const video = Buffer.from("exact-video");
      const thumbnail = Buffer.from("exact-thumbnail");
      const videoPath = join(directory, "video.mp4");
      const thumbnailPath = join(directory, "thumbnail.jpg");
      await Promise.all([
        writeFile(videoPath, video),
        writeFile(thumbnailPath, thumbnail),
      ]);
      const plan = exportPlan(video, thumbnail);
      if (identityPart === "size") plan.video.sizeBytes += 1n;
      else plan.video.sha256 = "0".repeat(64);

      await expect(
        new StreamingZip64PackageExporter().export({
          plan,
          outputPath: join(directory, `${identityPart}-mismatch.zip`),
          signal: new AbortController().signal,
          openInput: async (objectKey) =>
            createReadStream(
              objectKey === "video-key" ? videoPath : thumbnailPath,
            ),
          onProgress: () => undefined,
        }),
      ).rejects.toMatchObject({ code: "EXPORT_INPUT_IDENTITY_MISMATCH" });
    },
  );

  it.runIf(process.env.EXPORT_ZIP64_LARGE_TESTS === "1")(
    "writes a disposable >4 GiB sparse input that an external ZIP64 reader accepts",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cf-export-zip64-large-"));
      directories.push(directory);
      const videoSize = 0x1_0000_0000n + 1n;
      const videoPath = join(directory, "large-sparse.mp4");
      const videoFile = await open(videoPath, "w", 0o600);
      await videoFile.truncate(Number(videoSize));
      await videoFile.close();
      const thumbnail = Buffer.from("large-zip64-thumbnail");
      const thumbnailPath = join(directory, "thumb.jpg");
      await writeFile(thumbnailPath, thumbnail);
      const plan = exportPlan(Buffer.alloc(0), thumbnail);
      plan.video.sizeBytes = videoSize;
      plan.video.sha256 = zeroSha256(videoSize);
      const outputPath = join(directory, "large.zip");
      await new StreamingZip64PackageExporter().export({
        plan,
        outputPath,
        signal: new AbortController().signal,
        openInput: async (objectKey) =>
          createReadStream(
            objectKey === "video-key" ? videoPath : thumbnailPath,
            { highWaterMark: 8 * 1024 * 1024 },
          ),
        onProgress: () => undefined,
      });
      expect(BigInt((await stat(outputPath)).size)).toBeGreaterThan(videoSize);
      const names = await execute("unzip", ["-Z1", outputPath]);
      expect(names.stdout.trim().split("\n")).toEqual([
        "video.mp4",
        "thumbnail.jpg",
        "metadata.txt",
        "metadata.json",
        "manifest.json",
      ]);
      const listing = await execute("unzip", ["-l", outputPath, "video.mp4"]);
      expect(listing.stdout).toContain(videoSize.toString());
    },
    180_000,
  );
});

function exportPlan(video: Buffer, thumbnail: Buffer): EditorialExportPlan {
  return {
    intentId: randomUUID(),
    approvalId: randomUUID(),
    approvalContractVersion: "manual-horizontal-approval-v1",
    exportContractVersion: "editorial-export-zip-v1",
    candidateFingerprint: "a".repeat(64),
    editorialPackageRevisionId: randomUUID(),
    editorialRevision: 3,
    processingTemplateRevisionId: randomUUID(),
    recipeRevisionId: randomUUID(),
    recipeRevision: 2,
    configurationFingerprint: "b".repeat(64),
    assemblyRenderResultId: randomUUID(),
    renderContractVersion: "horizontal-render-v1",
    video: {
      artifactId: randomUUID(),
      objectKey: "video-key",
      sizeBytes: BigInt(video.length),
      sha256: sha256(video),
    },
    thumbnail: {
      assetId: randomUUID(),
      objectKey: "thumbnail-key",
      sizeBytes: BigInt(thumbnail.length),
      sha256: sha256(thumbnail),
      contentType: "image/jpeg",
      originalFilename: "../../unsafe.jpg",
    },
    metadata: {
      title: "Точный заголовок",
      description: "Строка 1\nСтрока 2",
      tags: ["first", "второй"],
    },
  };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function reverseObjectInsertionOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectInsertionOrder);
  if (!value || typeof value !== "object" || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, item]) => [key, reverseObjectInsertionOrder(item)]),
  );
}

function zeroSha256(size: bigint): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let remaining = size;
  while (remaining > 0n) {
    const length = Number(
      remaining > BigInt(chunk.length) ? BigInt(chunk.length) : remaining,
    );
    hash.update(length === chunk.length ? chunk : chunk.subarray(0, length));
    remaining -= BigInt(length);
  }
  return hash.digest("hex");
}

async function readStoredZipEntries(
  path: string,
): Promise<Map<string, Buffer>> {
  const archive = await readFile(path);
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const compressionMethod = archive.readUInt16LE(offset + 8);
    if (compressionMethod !== 0)
      throw new Error("test parser only supports stored ZIP entries");
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const extraStart = nameStart + nameLength;
    const dataStart = extraStart + extraLength;
    const name = archive.subarray(nameStart, extraStart).toString("utf8");
    const size = readZip64UncompressedSize(
      archive.subarray(extraStart, dataStart),
    );
    const dataEnd = dataStart + Number(size);
    entries.set(name, archive.subarray(dataStart, dataEnd));
    offset = dataEnd + 24;
  }
  return entries;
}

function readZip64UncompressedSize(extra: Buffer): bigint {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    if (headerId === 0x0001 && dataSize >= 16)
      return extra.readBigUInt64LE(offset + 4);
    offset += 4 + dataSize;
  }
  throw new Error("ZIP64 size extra field is missing");
}
