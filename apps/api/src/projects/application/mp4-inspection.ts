import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

import { UploadError } from "./upload-errors.js";

const MAX_MOVIE_METADATA_BYTES = 16 * 1024 * 1024;
const MIN_MEDIA_PAYLOAD_BYTES = 16;
const MP4_BRANDS = new Set([
  "avc1",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "M4V ",
  "mp41",
  "mp42",
  "MSNV",
]);

interface BufferBox {
  type: string;
  payloadStart: number;
  payloadEnd: number;
}

interface MediaRange {
  payloadStart: bigint;
  payloadEnd: bigint;
}

interface SampleSizes {
  count: number;
  at(index: number): number;
}

interface SampleToChunk {
  firstChunk: number;
  samplesPerChunk: number;
  sampleDescriptionIndex: number;
}

const VIDEO_SAMPLE_ENTRY_TYPES = new Set([
  "avc1",
  "avc3",
  "hev1",
  "hvc1",
  "mp4v",
]);

export interface InspectedMp4 {
  sizeBytes: bigint;
  sha256: string;
  contentType: "video/mp4";
}

export async function inspectMp4(filePath: string): Promise<InspectedMp4> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile() || fileStats.size < 64)
    invalid("The uploaded file is not a valid MP4.");

  const handle = await open(filePath, "r");
  try {
    const firstHeader = Buffer.alloc(Math.min(fileStats.size, 4096));
    const { bytesRead } = await handle.read(
      firstHeader,
      0,
      firstHeader.length,
      0,
    );
    const firstSize = firstHeader.readUInt32BE(0);
    if (
      firstHeader.toString("ascii", 4, 8) !== "ftyp" ||
      firstSize < 16 ||
      firstSize > bytesRead ||
      firstSize % 4 !== 0
    ) {
      invalid("The uploaded file is not a valid MP4.");
    }
    const brands = [firstHeader.toString("ascii", 8, 12)];
    for (let offset = 16; offset + 4 <= firstSize; offset += 4) {
      brands.push(firstHeader.toString("ascii", offset, offset + 4));
    }
    if (!brands.some((brand) => MP4_BRANDS.has(brand))) {
      invalid("The uploaded file is not a supported MP4.");
    }

    const fileSize = BigInt(fileStats.size);
    let offset = BigInt(firstSize);
    const mediaRanges: MediaRange[] = [];
    let movieMetadata: Buffer | undefined;
    while (offset < fileSize) {
      const boxHeader = Buffer.alloc(16);
      const result = await handle.read(boxHeader, 0, 16, Number(offset));
      if (result.bytesRead < 8) invalid("The uploaded MP4 is truncated.");
      const type = boxHeader.toString("ascii", 4, 8);
      let size = BigInt(boxHeader.readUInt32BE(0));
      let headerSize = 8n;
      if (size === 1n) {
        if (result.bytesRead < 16) invalid("The uploaded MP4 is truncated.");
        size = boxHeader.readBigUInt64BE(8);
        headerSize = 16n;
      } else if (size === 0n) {
        size = fileSize - offset;
      }
      if (size < headerSize || offset + size > fileSize) {
        invalid("The uploaded MP4 has invalid boxes.");
      }
      const payloadSize = size - headerSize;
      if (type === "mdat" && payloadSize >= MIN_MEDIA_PAYLOAD_BYTES) {
        mediaRanges.push({
          payloadStart: offset + headerSize,
          payloadEnd: offset + size,
        });
      }
      if (type === "moov") {
        if (movieMetadata) invalid("The uploaded MP4 has multiple moov boxes.");
        if (
          payloadSize <= 0n ||
          payloadSize > BigInt(MAX_MOVIE_METADATA_BYTES)
        ) {
          invalid("The uploaded MP4 has invalid movie metadata.");
        }
        const payload = Buffer.alloc(Number(payloadSize));
        const metadata = await handle.read(
          payload,
          0,
          payload.length,
          Number(offset + headerSize),
        );
        if (metadata.bytesRead !== payload.length)
          invalid("The uploaded MP4 movie metadata is truncated.");
        movieMetadata = payload;
      }
      offset += size;
    }
    if (
      mediaRanges.length === 0 ||
      !movieMetadata ||
      !hasVideoTrack(movieMetadata, mediaRanges)
    ) {
      invalid("The uploaded MP4 has no structurally valid video content.");
    }
  } finally {
    await handle.close();
  }

  const sha256 = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
  return {
    sizeBytes: BigInt(fileStats.size),
    sha256,
    contentType: "video/mp4",
  };
}

function hasVideoTrack(moov: Buffer, mediaRanges: MediaRange[]): boolean {
  return parseBoxes(moov).some((box) => {
    if (box.type !== "trak") return false;
    const track = moov.subarray(box.payloadStart, box.payloadEnd);
    const trackBoxes = parseBoxes(track);
    const trackHeader = trackBoxes.find((child) => child.type === "tkhd");
    const media = trackBoxes.find((child) => child.type === "mdia");
    if (
      !trackHeader ||
      trackHeader.payloadEnd - trackHeader.payloadStart < 20 ||
      !media
    ) {
      return false;
    }
    const mediaPayload = track.subarray(media.payloadStart, media.payloadEnd);
    const mediaBoxes = parseBoxes(mediaPayload);
    const mediaHeader = mediaBoxes.find((child) => child.type === "mdhd");
    const handler = mediaBoxes.find((child) => child.type === "hdlr");
    const mediaInformation = mediaBoxes.find((child) => child.type === "minf");
    if (
      !mediaHeader ||
      mediaHeader.payloadEnd - mediaHeader.payloadStart < 20 ||
      !handler ||
      handler.payloadEnd - handler.payloadStart < 12 ||
      mediaPayload.toString(
        "ascii",
        handler.payloadStart + 8,
        handler.payloadStart + 12,
      ) !== "vide" ||
      !mediaInformation
    ) {
      return false;
    }
    const minf = mediaPayload.subarray(
      mediaInformation.payloadStart,
      mediaInformation.payloadEnd,
    );
    const sampleTableBox = parseBoxes(minf).find(
      (child) => child.type === "stbl",
    );
    if (!sampleTableBox) return false;
    return hasConsistentVideoSamples(
      minf.subarray(sampleTableBox.payloadStart, sampleTableBox.payloadEnd),
      mediaRanges,
    );
  });
}

function hasConsistentVideoSamples(
  sampleTable: Buffer,
  mediaRanges: MediaRange[],
): boolean {
  const boxes = parseBoxes(sampleTable);
  const stsd = boxes.find((box) => box.type === "stsd");
  const stsc = boxes.find((box) => box.type === "stsc");
  const stsz = boxes.find((box) => box.type === "stsz");
  const stco = boxes.find((box) => box.type === "stco");
  const co64 = boxes.find((box) => box.type === "co64");
  if (!stsd || !stsc || !stsz || (!stco && !co64) || (stco && co64))
    return false;

  const sampleDescriptionCount = parseVideoSampleDescriptions(
    sampleTable.subarray(stsd.payloadStart, stsd.payloadEnd),
  );
  if (sampleDescriptionCount === 0) return false;
  const samples = parseSampleSizes(
    sampleTable.subarray(stsz.payloadStart, stsz.payloadEnd),
  );
  const sampleToChunk = parseSampleToChunk(
    sampleTable.subarray(stsc.payloadStart, stsc.payloadEnd),
    sampleDescriptionCount,
  );
  const chunkOffsets = parseChunkOffsets(
    sampleTable.subarray(
      (stco ?? co64!).payloadStart,
      (stco ?? co64!).payloadEnd,
    ),
    Boolean(co64),
  );
  if (!samples || sampleToChunk.length === 0 || chunkOffsets.length === 0)
    return false;

  let sampleIndex = 0;
  let mappingIndex = 0;
  for (let chunkIndex = 1; chunkIndex <= chunkOffsets.length; chunkIndex += 1) {
    while (
      mappingIndex + 1 < sampleToChunk.length &&
      sampleToChunk[mappingIndex + 1]!.firstChunk <= chunkIndex
    ) {
      mappingIndex += 1;
    }
    const mapping = sampleToChunk[mappingIndex]!;
    if (sampleIndex + mapping.samplesPerChunk > samples.count) return false;
    let chunkBytes = 0n;
    for (let index = 0; index < mapping.samplesPerChunk; index += 1) {
      const sampleBytes = samples.at(sampleIndex + index);
      if (sampleBytes <= 0) return false;
      chunkBytes += BigInt(sampleBytes);
    }
    const chunkStart = chunkOffsets[chunkIndex - 1]!;
    if (
      !mediaRanges.some(
        (range) =>
          chunkStart >= range.payloadStart &&
          chunkStart + chunkBytes <= range.payloadEnd,
      )
    ) {
      return false;
    }
    sampleIndex += mapping.samplesPerChunk;
  }
  return sampleIndex === samples.count;
}

function parseVideoSampleDescriptions(payload: Buffer): number {
  if (payload.length < 16) return 0;
  const count = payload.readUInt32BE(4);
  if (count === 0) return 0;
  const descriptions = payload.subarray(8);
  const entries = parseBoxes(descriptions);
  if (entries.length !== count) return 0;
  return entries.every((entry) => {
    const sampleEntry = descriptions.subarray(
      entry.payloadStart,
      entry.payloadEnd,
    );
    if (
      !VIDEO_SAMPLE_ENTRY_TYPES.has(entry.type) ||
      sampleEntry.length < 86 ||
      sampleEntry.readUInt16BE(6) === 0 ||
      sampleEntry.readUInt16BE(24) === 0 ||
      sampleEntry.readUInt16BE(26) === 0 ||
      sampleEntry.readUInt16BE(40) === 0
    ) {
      return false;
    }
    const codecConfigurationType =
      entry.type === "avc1" || entry.type === "avc3"
        ? "avcC"
        : entry.type === "hvc1" || entry.type === "hev1"
          ? "hvcC"
          : "esds";
    return parseBoxes(sampleEntry.subarray(78)).some(
      (extension) =>
        extension.type === codecConfigurationType &&
        extension.payloadEnd - extension.payloadStart >= 4,
    );
  })
    ? count
    : 0;
}

function parseSampleSizes(payload: Buffer): SampleSizes | undefined {
  if (payload.length < 12) return undefined;
  const uniformSize = payload.readUInt32BE(4);
  const count = payload.readUInt32BE(8);
  if (count === 0) return undefined;
  if (uniformSize > 0) return { count, at: () => uniformSize };
  if (count > Math.floor((payload.length - 12) / 4)) return undefined;
  return {
    count,
    at: (index) => payload.readUInt32BE(12 + index * 4),
  };
}

function parseSampleToChunk(
  payload: Buffer,
  descriptionCount: number,
): SampleToChunk[] {
  if (payload.length < 8) return [];
  const count = payload.readUInt32BE(4);
  if (count === 0 || count > Math.floor((payload.length - 8) / 12)) return [];
  const entries: SampleToChunk[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * 12;
    const entry = {
      firstChunk: payload.readUInt32BE(offset),
      samplesPerChunk: payload.readUInt32BE(offset + 4),
      sampleDescriptionIndex: payload.readUInt32BE(offset + 8),
    };
    if (
      entry.firstChunk === 0 ||
      entry.samplesPerChunk === 0 ||
      entry.sampleDescriptionIndex === 0 ||
      entry.sampleDescriptionIndex > descriptionCount ||
      (index === 0 && entry.firstChunk !== 1) ||
      (index > 0 && entry.firstChunk <= entries[index - 1]!.firstChunk)
    ) {
      return [];
    }
    entries.push(entry);
  }
  return entries;
}

function parseChunkOffsets(
  payload: Buffer,
  uses64BitOffsets: boolean,
): bigint[] {
  if (payload.length < 8) return [];
  const count = payload.readUInt32BE(4);
  const width = uses64BitOffsets ? 8 : 4;
  if (count === 0 || count > Math.floor((payload.length - 8) / width))
    return [];
  const offsets: bigint[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * width;
    offsets.push(
      uses64BitOffsets
        ? payload.readBigUInt64BE(offset)
        : BigInt(payload.readUInt32BE(offset)),
    );
  }
  return offsets;
}

function parseBoxes(buffer: Buffer): BufferBox[] {
  const boxes: BufferBox[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length)
      invalid("The uploaded MP4 metadata is truncated.");
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length)
        invalid("The uploaded MP4 metadata is truncated.");
      const extended = buffer.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER))
        invalid("The MP4 metadata is too large.");
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < headerSize || offset + size > buffer.length) {
      invalid("The uploaded MP4 metadata has invalid boxes.");
    }
    boxes.push({
      type,
      payloadStart: offset + headerSize,
      payloadEnd: offset + size,
    });
    offset += size;
  }
  return boxes;
}

function invalid(message: string): never {
  throw new UploadError("INVALID_MP4", message, 415);
}
