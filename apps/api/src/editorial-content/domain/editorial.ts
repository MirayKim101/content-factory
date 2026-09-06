import { inflateSync } from "node:zlib";

export const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;
export const THUMBNAIL_MAX_PIXELS = 40_000_000;

export type ThumbnailContentType = "image/jpeg" | "image/png" | "image/webp";

export interface ProcessingTemplateRevisionView {
  id: string;
  templateId: string;
  revision: number;
  name: string;
  configurationVersion: string;
  createdAt: Date;
}

export interface EditorialAssetView {
  id: string;
  projectId: string;
  type: "THUMBNAIL";
  status: "PENDING" | "READY" | "FAILED_FINAL";
  originalFilename: string;
  contentType: ThumbnailContentType;
  sizeBytes: bigint;
  sha256: string;
  width: number;
  height: number;
  failure?: { code: string; message: string };
  createdAt: Date;
  updatedAt: Date;
}

export const EDITORIAL_MISSING_FIELDS = [
  "TITLE",
  "DESCRIPTION",
  "TAGS",
  "THUMBNAIL",
] as const;
export type EditorialMissingField = (typeof EDITORIAL_MISSING_FIELDS)[number];

export interface EditorialPackageView {
  id: string;
  projectId: string;
  pipelineJobId: string;
  cutResultArtifact: {
    id: string;
    sha256: string;
    sizeBytes: bigint;
    sourceId: string;
    sourceVersion: number;
    recipeVersion: string;
  };
  revision: {
    id: string;
    revision: number;
    processingTemplateRevision: ProcessingTemplateRevisionView;
    title: string | null;
    description: string | null;
    tags: string[] | null;
    thumbnail: EditorialAssetView | null;
    provenance: {
      metadata: EditorialComponentProvenanceView;
      thumbnail: EditorialComponentProvenanceView;
    };
    createdAt: Date;
  };
  validation: {
    complete: boolean;
    missingFields: EditorialMissingField[];
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface EditorialComponentProvenanceView {
  mode: "MANUAL" | "AI_ASSISTED" | "MIXED";
  basisVersion: string;
}

export const MANUAL_EDITORIAL_PROVENANCE = {
  mode: "MANUAL",
  basisVersion: "manual-editorial-v1",
} as const satisfies EditorialComponentProvenanceView;

export const LEGACY_MANUAL_EDITORIAL_PROVENANCE = {
  mode: "MANUAL",
  basisVersion: "legacy-manual-editorial-v1",
} as const satisfies EditorialComponentProvenanceView;

export function editorialValidation(input: {
  title: string | null;
  description: string | null;
  tags: string[] | null;
  thumbnail: EditorialAssetView | null;
}): EditorialPackageView["validation"] {
  const missingFields: EditorialMissingField[] = [];
  if (!input.title?.trim()) missingFields.push("TITLE");
  if (!input.description?.trim()) missingFields.push("DESCRIPTION");
  if (!input.tags || input.tags.length === 0) missingFields.push("TAGS");
  if (!input.thumbnail || input.thumbnail.status !== "READY") {
    missingFields.push("THUMBNAIL");
  }
  return { complete: missingFields.length === 0, missingFields };
}

export class ThumbnailValidationError extends Error {
  constructor(
    readonly code:
      | "THUMBNAIL_FORMAT_UNSUPPORTED"
      | "THUMBNAIL_MIME_MISMATCH"
      | "THUMBNAIL_CORRUPT"
      | "THUMBNAIL_PIXEL_LIMIT_EXCEEDED",
    message: string,
  ) {
    super(message);
  }
}

export function inspectThumbnail(
  bytes: Buffer,
  declaredContentType: string,
): { contentType: ThumbnailContentType; width: number; height: number } {
  const detected = detectThumbnail(bytes);
  if (!detected) {
    throw new ThumbnailValidationError(
      "THUMBNAIL_FORMAT_UNSUPPORTED",
      "Only structurally valid JPEG, PNG, and WebP thumbnails are supported.",
    );
  }
  if (declaredContentType.toLowerCase() !== detected.contentType) {
    throw new ThumbnailValidationError(
      "THUMBNAIL_MIME_MISMATCH",
      "The declared thumbnail type does not match its bytes.",
    );
  }
  if (
    detected.width <= 0 ||
    detected.height <= 0 ||
    detected.width * detected.height > THUMBNAIL_MAX_PIXELS
  ) {
    throw new ThumbnailValidationError(
      "THUMBNAIL_PIXEL_LIMIT_EXCEEDED",
      `Thumbnail dimensions must contain at most ${THUMBNAIL_MAX_PIXELS} pixels.`,
    );
  }
  return detected;
}

function detectThumbnail(bytes: Buffer): {
  contentType: ThumbnailContentType;
  width: number;
  height: number;
} | null {
  if (
    bytes.length >= 45 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    const dimensions = validatePng(bytes);
    return {
      contentType: "image/png",
      ...dimensions,
    };
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return detectJpeg(bytes);
  }
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return detectWebp(bytes);
  }
  return null;
}

function detectJpeg(bytes: Buffer): {
  contentType: "image/jpeg";
  width: number;
  height: number;
} {
  if (
    bytes.length < 4 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    corrupt();
  }
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawQuantization = false;
  let sawHuffman = false;
  let sawScan = false;
  let entropyBytes = 0;
  let frameMarker = 0;
  const frameComponents = new Set<number>();
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) corrupt();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) {
      if (
        offset !== bytes.length ||
        width === 0 ||
        height === 0 ||
        !sawQuantization ||
        !sawScan ||
        entropyBytes === 0
      ) {
        corrupt();
      }
      return { contentType: "image/jpeg", width, height };
    }
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      corrupt();
    }
    if (offset + 2 > bytes.length) corrupt();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) corrupt();
    if (marker === 0xdb) {
      validateJpegQuantizationTables(
        bytes.subarray(offset + 2, offset + length),
      );
      sawQuantization = true;
    }
    if (marker === 0xc4) {
      validateJpegHuffmanTables(bytes.subarray(offset + 2, offset + length));
      sawHuffman = true;
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (width !== 0 || height !== 0) corrupt();
      frameMarker = marker;
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7]!;
      if (components === 0 || length !== 8 + components * 3) corrupt();
      for (let index = 0; index < components; index += 1) {
        const componentOffset = offset + 8 + index * 3;
        const componentId = bytes[componentOffset]!;
        const sampling = bytes[componentOffset + 1]!;
        const horizontalSampling = sampling >>> 4;
        const verticalSampling = sampling & 0x0f;
        const quantizationTable = bytes[componentOffset + 2]!;
        if (
          componentId === 0 ||
          frameComponents.has(componentId) ||
          horizontalSampling < 1 ||
          horizontalSampling > 4 ||
          verticalSampling < 1 ||
          verticalSampling > 4 ||
          quantizationTable > 3
        ) {
          corrupt();
        }
        frameComponents.add(componentId);
      }
    } else if (
      (marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8) ||
      marker === 0xcc
    ) {
      corrupt();
    }
    if (marker === 0xda) {
      if (width === 0 || height === 0 || !sawQuantization) corrupt();
      if (!sawHuffman) corrupt();
      const components = bytes[offset + 2]!;
      if (components === 0 || length !== 6 + components * 2) corrupt();
      const scanComponents = new Set<number>();
      for (let index = 0; index < components; index += 1) {
        const componentOffset = offset + 3 + index * 2;
        const componentId = bytes[componentOffset]!;
        const huffmanTables = bytes[componentOffset + 1]!;
        if (
          !frameComponents.has(componentId) ||
          scanComponents.has(componentId) ||
          huffmanTables >>> 4 > 3 ||
          (huffmanTables & 0x0f) > 3
        ) {
          corrupt();
        }
        scanComponents.add(componentId);
      }
      if (
        frameMarker !== 0xc2 &&
        (bytes[offset + length - 3] !== 0 ||
          bytes[offset + length - 2] !== 63 ||
          bytes[offset + length - 1] !== 0)
      ) {
        corrupt();
      }
      sawScan = true;
      offset += length;
      let scanBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          scanBytes += 1;
          offset += 1;
          continue;
        }
        const markerOffset = offset;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) corrupt();
        const scanMarker = bytes[offset]!;
        if (scanMarker === 0x00) {
          scanBytes += 1;
          offset += 1;
          continue;
        }
        if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          offset += 1;
          continue;
        }
        offset = markerOffset;
        break;
      }
      if (scanBytes === 0) corrupt();
      entropyBytes += scanBytes;
      continue;
    }
    offset += length;
  }
  corrupt();
}

function detectWebp(bytes: Buffer): {
  contentType: "image/webp";
  width: number;
  height: number;
} {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) corrupt();
  let offset = 12;
  let extended: { width: number; height: number } | null = null;
  let decoded: { width: number; height: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const chunk = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length % 2);
    if (dataEnd > bytes.length || paddedEnd > bytes.length) corrupt();
    if (chunk === "VP8X") {
      if (extended || length !== 10) corrupt();
      if (
        (bytes[dataStart]! & 0xc1) !== 0 ||
        readUInt24LE(bytes, dataStart + 1) !== 0
      ) {
        corrupt();
      }
      extended = {
        width: readUInt24LE(bytes, dataStart + 4) + 1,
        height: readUInt24LE(bytes, dataStart + 7) + 1,
      };
    } else if (chunk === "VP8L") {
      if (decoded || length < 6 || bytes[dataStart] !== 0x2f) corrupt();
      const packed = bytes.readUInt32LE(dataStart + 1);
      if (packed >>> 29 !== 0) corrupt();
      decoded = {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    } else if (chunk === "VP8 ") {
      if (
        decoded ||
        length < 11 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        corrupt();
      }
      const frameTag =
        bytes[dataStart]! |
        (bytes[dataStart + 1]! << 8) |
        (bytes[dataStart + 2]! << 16);
      const firstPartitionLength = frameTag >>> 5;
      if (
        (frameTag & 1) !== 0 ||
        ((frameTag >>> 4) & 1) !== 1 ||
        firstPartitionLength === 0 ||
        firstPartitionLength > length - 10
      ) {
        corrupt();
      }
      decoded = {
        width: bytes.readUInt16LE(dataStart + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataStart + 8) & 0x3fff,
      };
    }
    if (length % 2 === 1 && bytes[dataEnd] !== 0) corrupt();
    offset = paddedEnd;
  }
  if (offset !== bytes.length || !decoded) corrupt();
  if (
    extended &&
    (extended.width !== decoded.width || extended.height !== decoded.height)
  ) {
    corrupt();
  }
  return { contentType: "image/webp", ...decoded };
}

function validatePng(bytes: Buffer): { width: number; height: number } {
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let colorType = -1;
  let interlace = 0;
  let sawPalette = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) corrupt();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!sawHeader && (type !== "IHDR" || length !== 13)) corrupt();
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (expectedCrc !== actualCrc) corrupt();
    if (type === "IHDR") {
      if (sawHeader) corrupt();
      sawHeader = true;
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      const bitDepth = bytes[offset + 16]!;
      colorType = bytes[offset + 17]!;
      if (
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        (bytes[offset + 20] !== 0 && bytes[offset + 20] !== 1)
      ) {
        corrupt();
      }
      interlace = bytes[offset + 20]!;
      bitsPerPixel = pngBitsPerPixel(bitDepth, colorType);
      if (width <= 0 || height <= 0 || width * height > THUMBNAIL_MAX_PIXELS) {
        throw new ThumbnailValidationError(
          "THUMBNAIL_PIXEL_LIMIT_EXCEEDED",
          `Thumbnail dimensions must contain at most ${THUMBNAIL_MAX_PIXELS} pixels.`,
        );
      }
    } else if (type === "PLTE") {
      if (
        !sawHeader ||
        sawPalette ||
        sawImageData ||
        colorType === 0 ||
        colorType === 4 ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0
      ) {
        corrupt();
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (!sawHeader || imageDataEnded || length === 0) corrupt();
      if (colorType === 3 && !sawPalette) corrupt();
      sawImageData = true;
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (sawImageData) {
      imageDataEnded = true;
    }
    if (type.length !== 4 || /[^A-Za-z]/.test(type)) corrupt();
    if (type !== "IHDR" && type !== "IDAT" && type !== "IEND") {
      const isCritical = (bytes[offset + 4]! & 0x20) === 0;
      if (isCritical && type !== "PLTE") corrupt();
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) corrupt();
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawHeader || !sawImageData || !sawEnd) corrupt();
  const expected = pngDecodedLength(width, height, bitsPerPixel, interlace);
  if (expected > 160 * 1024 * 1024) {
    throw new ThumbnailValidationError(
      "THUMBNAIL_PIXEL_LIMIT_EXCEEDED",
      "Thumbnail decoded pixel data is too large.",
    );
  }
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(compressed), {
      maxOutputLength: expected + 1,
    });
  } catch {
    corrupt();
  }
  if (decoded.length !== expected) corrupt();
  validatePngFilters(decoded, width, height, bitsPerPixel, interlace);
  return { width, height };
}

function pngBitsPerPixel(bitDepth: number, colorType: number): number {
  const allowed: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!allowed[colorType]?.includes(bitDepth)) corrupt();
  const channels =
    colorType === 0 || colorType === 3
      ? 1
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : 4;
  return channels * bitDepth;
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

function pngDecodedLength(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
): number {
  if (interlace === 0)
    return height * (1 + Math.ceil((width * bitsPerPixel) / 8));
  return ADAM7.reduce((total, [x, y, dx, dy]) => {
    const passWidth = width <= x ? 0 : Math.ceil((width - x) / dx);
    const passHeight = height <= y ? 0 : Math.ceil((height - y) / dy);
    return (
      total +
      (passWidth === 0
        ? 0
        : passHeight * (1 + Math.ceil((passWidth * bitsPerPixel) / 8)))
    );
  }, 0);
}

function validatePngFilters(
  decoded: Buffer,
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
): void {
  let offset = 0;
  const passes = interlace === 0 ? ([[0, 0, 1, 1]] as const) : ADAM7;
  for (const [x, y, dx, dy] of passes) {
    const passWidth = width <= x ? 0 : Math.ceil((width - x) / dx);
    const passHeight = height <= y ? 0 : Math.ceil((height - y) / dy);
    if (passWidth === 0) continue;
    const rowLength = 1 + Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let row = 0; row < passHeight; row += 1) {
      if (decoded[offset] === undefined || decoded[offset]! > 4) corrupt();
      offset += rowLength;
    }
  }
  if (offset !== decoded.length) corrupt();
}

function validateJpegQuantizationTables(data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const precision = data[offset]! >>> 4;
    if (precision > 1) corrupt();
    offset += 1 + (precision === 0 ? 64 : 128);
  }
  if (offset !== data.length || data.length === 0) corrupt();
}

function validateJpegHuffmanTables(data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    if (offset + 17 > data.length || data[offset]! >>> 4 > 1) corrupt();
    let symbols = 0;
    for (let index = 1; index <= 16; index += 1) {
      symbols += data[offset + index]!;
    }
    offset += 17 + symbols;
  }
  if (offset !== data.length || data.length === 0) corrupt();
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function corrupt(): never {
  throw new ThumbnailValidationError(
    "THUMBNAIL_CORRUPT",
    "Thumbnail dimensions could not be read safely.",
  );
}
