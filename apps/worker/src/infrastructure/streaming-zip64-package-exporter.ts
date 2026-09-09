import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { crc32 as updateCrc32 } from "node:zlib";

import type {
  PackageExporter,
  PackageExporterResult,
} from "../application/ports.js";
import { ControlledMediaError } from "../domain/media-job.js";

interface WrittenEntry {
  name: string;
  sizeBytes: bigint;
  sha256: string;
  crc32: number;
  localOffset: bigint;
}

const UTF8_DATA_DESCRIPTOR = 0x0808;
const ZIP64_VERSION = 45;

export class StreamingZip64PackageExporter implements PackageExporter {
  async export(
    input: Parameters<PackageExporter["export"]>[0],
  ): Promise<PackageExporterResult> {
    const metadataText = metadataTextBytes(input.plan.metadata);
    const metadataJson = jsonLine({
      metadataSchemaVersion: "editorial-metadata-v1",
      title: input.plan.metadata.title,
      description: input.plan.metadata.description,
      tags: input.plan.metadata.tags,
    });
    const thumbnailName = thumbnailEntryName(input.plan.thumbnail.contentType);
    const totalPayloadBytes =
      input.plan.video.sizeBytes +
      input.plan.thumbnail.sizeBytes +
      BigInt(metadataText.length + metadataJson.length);
    const file = await open(input.outputPath, "wx", 0o600);
    let offset = 0n;
    let readBytes = 0n;
    const entries: WrittenEntry[] = [];
    const write = async (buffer: Buffer): Promise<void> => {
      abortIfNeeded(input.signal);
      let written = 0;
      while (written < buffer.length) {
        const result = await file.write(
          buffer,
          written,
          buffer.length - written,
          Number(offset) + written,
        );
        if (result.bytesWritten <= 0) throw new Error("ZIP_WRITE_STALLED");
        written += result.bytesWritten;
      }
      offset += BigInt(buffer.length);
      input.onProgress({
        phase: "WRITE_ARCHIVE",
        bytes: offset,
        totalBytes: totalPayloadBytes,
      });
    };

    const writeEntry = async (
      name: string,
      expectedSize: bigint,
      source: () => Promise<NodeJS.ReadableStream>,
      expectedSha256?: string,
    ): Promise<WrittenEntry> => {
      const nameBytes = Buffer.from(name, "utf8");
      const localOffset = offset;
      await write(localHeader(nameBytes, expectedSize));
      const hash = createHash("sha256");
      let crc = 0;
      let count = 0n;
      const stream = await source();
      for await (const rawChunk of stream as AsyncIterable<Uint8Array>) {
        abortIfNeeded(input.signal);
        const chunk = Buffer.from(rawChunk);
        count += BigInt(chunk.length);
        if (count > expectedSize)
          throw identityError(name, "size exceeds captured identity");
        hash.update(chunk);
        crc = updateCrc32(chunk, crc);
        await write(chunk);
        readBytes += BigInt(chunk.length);
        input.onProgress({
          phase: "READ_INPUTS",
          bytes: readBytes,
          totalBytes: totalPayloadBytes,
        });
      }
      const sha256 = hash.digest("hex");
      if (
        count !== expectedSize ||
        (expectedSha256 && sha256 !== expectedSha256)
      )
        throw identityError(
          name,
          "checksum or size differs from captured identity",
        );
      const crc32 = crc >>> 0;
      await write(dataDescriptor(crc32, count));
      const entry = { name, sizeBytes: count, sha256, crc32, localOffset };
      entries.push(entry);
      return entry;
    };

    try {
      const video = await writeEntry(
        "video.mp4",
        input.plan.video.sizeBytes,
        () => input.openInput(input.plan.video.objectKey),
        input.plan.video.sha256,
      );
      const thumbnail = await writeEntry(
        thumbnailName,
        input.plan.thumbnail.sizeBytes,
        () => input.openInput(input.plan.thumbnail.objectKey),
        input.plan.thumbnail.sha256,
      );
      const metadataTextEntry = await writeEntry(
        "metadata.txt",
        BigInt(metadataText.length),
        async () => Readable.from([metadataText]),
      );
      const metadataJsonEntry = await writeEntry(
        "metadata.json",
        BigInt(metadataJson.length),
        async () => Readable.from([metadataJson]),
      );
      const manifest = {
        manifestSchemaVersion: "editorial-export-manifest-v1",
        exportContractVersion: input.plan.exportContractVersion,
        approvalContractVersion: input.plan.approvalContractVersion,
        exportIntentId: input.plan.intentId,
        approvalId: input.plan.approvalId,
        candidateFingerprint: input.plan.candidateFingerprint,
        editorialPackageRevisionId: input.plan.editorialPackageRevisionId,
        editorialRevision: input.plan.editorialRevision,
        processingTemplateRevisionId: input.plan.processingTemplateRevisionId,
        recipeRevisionId: input.plan.recipeRevisionId,
        recipeRevision: input.plan.recipeRevision,
        configurationFingerprint: input.plan.configurationFingerprint,
        assemblyRenderResultId: input.plan.assemblyRenderResultId,
        renderContractVersion: input.plan.renderContractVersion,
        entries: [video, thumbnail, metadataTextEntry, metadataJsonEntry].map(
          ({ name, sizeBytes, sha256 }) => ({
            name,
            sizeBytes: sizeBytes.toString(),
            sha256,
          }),
        ),
      };
      const manifestBytes = jsonLine(manifest);
      await writeEntry(
        "manifest.json",
        BigInt(manifestBytes.length),
        async () => Readable.from([manifestBytes]),
      );

      const centralOffset = offset;
      for (const entry of entries) await write(centralHeader(entry));
      const centralSize = offset - centralOffset;
      const zip64EocdOffset = offset;
      await write(zip64End(entries.length, centralSize, centralOffset));
      await write(zip64Locator(zip64EocdOffset));
      await write(legacyEnd());
      await file.sync();
      return { manifest, archiveBytes: offset };
    } finally {
      await file.close();
    }
  }
}

function metadataTextBytes(metadata: {
  title: string;
  description: string;
  tags: string[];
}): Buffer {
  return Buffer.from(
    `TITLE\n${metadata.title}\n\nDESCRIPTION\n${metadata.description}\n\nTAGS\n${metadata.tags.join("\n")}\n`,
    "utf8",
  );
}

function jsonLine(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function thumbnailEntryName(contentType: string): string {
  if (contentType === "image/jpeg") return "thumbnail.jpg";
  if (contentType === "image/png") return "thumbnail.png";
  if (contentType === "image/webp") return "thumbnail.webp";
  throw new ControlledMediaError(
    "EXPORT_THUMBNAIL_TYPE_UNSUPPORTED",
    "The approved thumbnail type cannot be exported.",
    false,
  );
}

function localHeader(name: Buffer, size: bigint): Buffer {
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(size, 4);
  extra.writeBigUInt64LE(size, 12);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP64_VERSION, 4);
  header.writeUInt16LE(UTF8_DATA_DESCRIPTOR, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0xffffffff, 18);
  header.writeUInt32LE(0xffffffff, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, name, extra]);
}

function dataDescriptor(crc32: number, size: bigint): Buffer {
  const value = Buffer.alloc(24);
  value.writeUInt32LE(0x08074b50, 0);
  value.writeUInt32LE(crc32, 4);
  value.writeBigUInt64LE(size, 8);
  value.writeBigUInt64LE(size, 16);
  return value;
}

function centralHeader(entry: WrittenEntry): Buffer {
  const name = Buffer.from(entry.name, "utf8");
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(entry.sizeBytes, 4);
  extra.writeBigUInt64LE(entry.sizeBytes, 12);
  extra.writeBigUInt64LE(entry.localOffset, 20);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(ZIP64_VERSION, 4);
  header.writeUInt16LE(ZIP64_VERSION, 6);
  header.writeUInt16LE(UTF8_DATA_DESCRIPTOR, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(0xffffffff, 20);
  header.writeUInt32LE(0xffffffff, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(0xffffffff, 42);
  return Buffer.concat([header, name, extra]);
}

function zip64End(entries: number, size: bigint, offset: bigint): Buffer {
  const value = Buffer.alloc(56);
  value.writeUInt32LE(0x06064b50, 0);
  value.writeBigUInt64LE(44n, 4);
  value.writeUInt16LE(ZIP64_VERSION, 12);
  value.writeUInt16LE(ZIP64_VERSION, 14);
  value.writeUInt32LE(0, 16);
  value.writeUInt32LE(0, 20);
  value.writeBigUInt64LE(BigInt(entries), 24);
  value.writeBigUInt64LE(BigInt(entries), 32);
  value.writeBigUInt64LE(size, 40);
  value.writeBigUInt64LE(offset, 48);
  return value;
}

function zip64Locator(offset: bigint): Buffer {
  const value = Buffer.alloc(20);
  value.writeUInt32LE(0x07064b50, 0);
  value.writeUInt32LE(0, 4);
  value.writeBigUInt64LE(offset, 8);
  value.writeUInt32LE(1, 16);
  return value;
}

function legacyEnd(): Buffer {
  const value = Buffer.alloc(22);
  value.writeUInt32LE(0x06054b50, 0);
  value.writeUInt16LE(0, 4);
  value.writeUInt16LE(0, 6);
  value.writeUInt16LE(0xffff, 8);
  value.writeUInt16LE(0xffff, 10);
  value.writeUInt32LE(0xffffffff, 12);
  value.writeUInt32LE(0xffffffff, 16);
  value.writeUInt16LE(0, 20);
  return value;
}

function identityError(name: string, reason: string): ControlledMediaError {
  return new ControlledMediaError(
    "EXPORT_INPUT_IDENTITY_MISMATCH",
    `Approved package input ${name} ${reason}.`,
    false,
  );
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
